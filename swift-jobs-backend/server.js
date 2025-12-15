require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /\.(pdf|doc|docx|txt)$/i;
    const allowedMimetypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    
    const extname = allowedExtensions.test(file.originalname.toLowerCase());
    const mimetype = allowedMimetypes.includes(file.mimetype);
    
    if (mimetype || extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Initialize Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Helper function to analyze with Groq
async function analyzeWithGroq(prompt) {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an expert HR and talent matching AI. Analyze candidates and jobs to provide accurate matching scores (0-100%) and detailed explanations."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.5,
      max_tokens: 1500
    });
    
    return completion.choices[0]?.message?.content || "";
  } catch (error) {
    console.error('Groq API error:', error);
    throw new Error('AI analysis failed');
  }
}

// Helper function to extract text from resume file
function extractResumeText(filePath) {
  // For now, we'll read text files directly
  // You can add PDF parsing libraries later (like pdf-parse)
  try {
    if (path.extname(filePath).toLowerCase() === '.txt') {
      return fs.readFileSync(filePath, 'utf8');
    }
    return `Resume file uploaded: ${path.basename(filePath)}`;
  } catch (error) {
    return 'Unable to extract resume text';
  }
}

// API Routes

// Job Seeker Registration (with file upload)
app.post('/api/jobseeker/register', upload.single('resume'), async (req, res) => {
  try {
    const { name, email, password, answers } = req.body;
    const resumeFile = req.file;

    if (!resumeFile) {
      return res.status(400).json({ success: false, error: 'Resume file is required' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 6 characters long' 
      });
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Extract resume text
    const resumeText = extractResumeText(resumeFile.path);
    const resumeUrl = `/uploads/${resumeFile.filename}`;

    // Parse answers if sent as string
    let behavioralAnswers;
    try {
      behavioralAnswers = typeof answers === 'string' ? JSON.parse(answers) : answers;
    } catch (parseError) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid answers format. Must be a JSON array like: ["answer1", "answer2", "answer3"]' 
      });
    }

    if (!Array.isArray(behavioralAnswers)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Answers must be an array' 
      });
    }

    // Analyze resume and answers with Groq
    const analysisPrompt = `Analyze this job seeker profile:
    
Resume: ${resumeText}

Behavioral Answers:
${behavioralAnswers.map((answer, idx) => `Q${idx + 1}: ${answer}`).join('\n')}

Provide a JSON response with:
{
  "technical_skills": ["skill1", "skill2", ...],
  "soft_skills": ["skill1", "skill2", ...],
  "work_style": "description",
  "experience_years": 3,
  "preferred_roles": ["role1", "role2", ...],
  "behavioral_traits": {
    "teamwork": "high/medium/low",
    "leadership": "high/medium/low",
    "adaptability": "high/medium/low"
  }
}`;

    const analysis = await analyzeWithGroq(analysisPrompt);
    let profileData;
    
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      profileData = jsonMatch ? JSON.parse(jsonMatch[0]) : {
        technical_skills: [],
        soft_skills: [],
        work_style: "Not specified",
        experience_years: 0,
        preferred_roles: [],
        behavioral_traits: {}
      };
    } catch (parseError) {
      profileData = {
        technical_skills: [],
        soft_skills: [],
        work_style: "Not specified",
        experience_years: 0,
        preferred_roles: [],
        behavioral_traits: {}
      };
    }

    // Insert user
    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert([{
        email,
        password_hash: hashedPassword, // Store hashed password
        user_type: 'job_seeker',
        full_name: name
      }])
      .select();

    if (userError) throw userError;

    const userId = userData[0].id;

    // Combine technical and soft skills
    const allSkills = [
      ...(profileData.technical_skills || []),
      ...(profileData.soft_skills || [])
    ];

    // Insert job seeker profile
    const { data: seekerData, error: seekerError } = await supabase
      .from('job_seekers')
      .insert([{
        user_id: userId,
        skills: allSkills, // Supabase will handle JSONB conversion
        experience_years: parseInt(profileData.experience_years) || 0,
        preferred_roles: profileData.preferred_roles || [],
        resume_text: resumeText,
        behavioral_traits: profileData.behavioral_traits || {},
        match_confidence: 0.0
      }])
      .select();

    if (seekerError) {
      console.error('Job seeker insert error:', seekerError);
      throw seekerError;
    }

    res.json({ 
      success: true, 
      userId: userId,
      seekerId: seekerData[0].id,
      resumeUrl: resumeUrl,
      analysis: {
        technical_skills: profileData.technical_skills || [],
        soft_skills: profileData.soft_skills || [],
        work_style: profileData.work_style || "Not specified",
        experience_years: profileData.experience_years || 0,
        preferred_roles: profileData.preferred_roles || [],
        behavioral_traits: profileData.behavioral_traits || {}
      }
    });
  } catch (error) {
    console.error('Error registering job seeker:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Employer Registration
app.post('/api/employer/register', async (req, res) => {
  try {
    const { name, email, password, companyName, companySize, industry } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 6 characters long' 
      });
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert user
    const { data: userData, error: userError } = await supabase
      .from('users')
      .insert([{
        email,
        password_hash: hashedPassword, // Store hashed password
        user_type: 'employer',
        full_name: name
      }])
      .select();

    if (userError) throw userError;

    const userId = userData[0].id;

    // Insert employer profile
    const { data: employerData, error: employerError } = await supabase
      .from('employers')
      .insert([{
        user_id: userId,
        company_name: companyName,
        company_size: companySize,
        industry: industry,
        hr_contact_name: name
      }])
      .select();

    if (employerError) throw employerError;

    res.json({ 
      success: true, 
      userId: userId,
      employerId: employerData[0].id
    });
  } catch (error) {
    console.error('Error registering employer:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Job Posting
app.post('/api/job/post', async (req, res) => {
  try {
    const { employerId, title, description, requirements, location, salaryRange } = req.body;

    // Analyze job requirements with Groq
    const analysisPrompt = `Analyze this job posting:
    
Title: ${title}
Description: ${description}
Requirements: ${requirements}

Provide a JSON response with:
{
  "required_skills": ["skill1", "skill2", ...],
  "behavioral_traits": {
    "teamwork": "high/medium/low",
    "leadership": "high/medium/low",
    "independence": "high/medium/low"
  },
  "experience_level": "junior/mid/senior"
}`;

    const analysis = await analyzeWithGroq(analysisPrompt);
    let jobData;
    
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      jobData = jsonMatch ? JSON.parse(jsonMatch[0]) : {
        required_skills: [],
        behavioral_traits: {},
        experience_level: "mid"
      };
    } catch (parseError) {
      jobData = {
        required_skills: [],
        behavioral_traits: {},
        experience_level: "mid"
      };
    }

    // Insert job listing
    const { data, error } = await supabase
      .from('job_listings')
      .insert([{
        employer_id: employerId,
        title,
        description,
        requirements: JSON.stringify(requirements),
        required_skills: JSON.stringify(jobData.required_skills),
        behavioral_traits: JSON.stringify(jobData.behavioral_traits),
        location,
        salary_range: salaryRange,
        is_active: true
      }])
      .select();

    if (error) throw error;

    res.json({ 
      success: true, 
      jobId: data[0].id,
      analysis: jobData
    });
  } catch (error) {
    console.error('Error posting job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get matches for job seeker
app.get('/api/matches/:seekerId', async (req, res) => {
  try {
    const { seekerId } = req.params;

    // Get job seeker profile
    const { data: seeker, error: seekerError } = await supabase
      .from('job_seekers')
      .select('*')
      .eq('id', seekerId)
      .single();

    if (seekerError) throw seekerError;

    // Get all active jobs
    const { data: jobs, error: jobsError } = await supabase
      .from('job_listings')
      .select('*, employers(*)')
      .eq('is_active', true);

    if (jobsError) throw jobsError;

    // Match each job with the seeker
    const matches = await Promise.all(jobs.map(async (job) => {
      const matchPrompt = `Score this job match (0-1.0):

Job Seeker:
Skills: ${seeker.skills}
Experience: ${seeker.experience_years} years
Preferred Roles: ${seeker.preferred_roles}

Job:
Title: ${job.title}
Required Skills: ${job.required_skills}
Description: ${job.description}

Provide a JSON response:
{
  "match_score": 0.85,
  "technical_fit": 0.90,
  "behavioral_fit": 0.80,
  "explanation": "Strong match because..."
}`;

      const matchResult = await analyzeWithGroq(matchPrompt);
      
      try {
        const jsonMatch = matchResult.match(/\{[\s\S]*\}/);
        const matchData = jsonMatch ? JSON.parse(jsonMatch[0]) : { 
          match_score: 0.70, 
          technical_fit: 0.70,
          behavioral_fit: 0.70,
          explanation: "Good general fit" 
        };
        
        return {
          jobId: job.id,
          jobTitle: job.title,
          company: job.employers.company_name,
          location: job.location,
          salaryRange: job.salary_range,
          matchScore: (matchData.match_score * 100).toFixed(0),
          technicalFit: (matchData.technical_fit * 100).toFixed(0),
          behavioralFit: (matchData.behavioral_fit * 100).toFixed(0),
          explanation: matchData.explanation
        };
      } catch (parseError) {
        return {
          jobId: job.id,
          jobTitle: job.title,
          company: job.employers.company_name,
          location: job.location,
          salaryRange: job.salary_range,
          matchScore: 70,
          technicalFit: 70,
          behavioralFit: 70,
          explanation: "Potential match based on profile"
        };
      }
    }));

    // Sort by match score and filter >= 75%
    const sortedMatches = matches
      .filter(m => m.matchScore >= 75)
      .sort((a, b) => b.matchScore - a.matchScore);

    res.json({ matches: sortedMatches });
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }

    // Get user from database
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }

    // Compare passwords
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }

    // Get additional profile data based on user type
    let profileData = null;
    if (user.user_type === 'job_seeker') {
      const { data } = await supabase
        .from('job_seekers')
        .select('*')
        .eq('user_id', user.id)
        .single();
      profileData = data;
    } else if (user.user_type === 'employer') {
      const { data } = await supabase
        .from('employers')
        .select('*')
        .eq('user_id', user.id)
        .single();
      profileData = data;
    }

    // Return user info (excluding password hash)
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        userType: user.user_type,
        createdAt: user.created_at
      },
      profile: profileData
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Swift Jobs API running on port ${PORT}`);
  console.log(`Uploads directory: ${uploadDir}`);
});