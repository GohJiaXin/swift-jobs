const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// API Routes

// Job Seeker Registration
app.post('/api/jobseeker/register', async (req, res) => {
  try {
    const { name, email, resume, answers } = req.body;

    // Analyze resume and answers with Groq
    const analysisPrompt = `Analyze this job seeker profile:
    
Resume: ${resume}

Behavioral Answers:
${answers.map((answer, idx) => `Q${idx + 1}: ${answer}`).join('\n')}

Provide a JSON response with:
{
  "technical_skills": ["skill1", "skill2", ...],
  "soft_skills": ["skill1", "skill2", ...],
  "work_style": "description",
  "preferences": "description",
  "experience_level": "junior/mid/senior",
  "key_strengths": ["strength1", "strength2", ...]
}`;

    const analysis = await analyzeWithGroq(analysisPrompt);
    let profileData;
    
    try {
      // Extract JSON from the response
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      profileData = jsonMatch ? JSON.parse(jsonMatch[0]) : {
        technical_skills: [],
        soft_skills: [],
        work_style: "Not specified",
        preferences: "Not specified",
        experience_level: "mid",
        key_strengths: []
      };
    } catch (parseError) {
      profileData = {
        technical_skills: [],
        soft_skills: [],
        work_style: "Not specified",
        preferences: "Not specified",
        experience_level: "mid",
        key_strengths: []
      };
    }

    // Insert into Supabase
    const { data, error } = await supabase
      .from('job_seekers')
      .insert([{
        name,
        email,
        resume,
        behavioral_answers: answers,
        profile_analysis: profileData,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    res.json({ 
      success: true, 
      userId: data[0].id,
      analysis: profileData
    });
  } catch (error) {
    console.error('Error registering job seeker:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Job Posting
app.post('/api/job/post', async (req, res) => {
  try {
    const { company, email, jobTitle, description, preferences } = req.body;

    // Analyze job requirements with Groq
    const analysisPrompt = `Analyze this job posting:
    
Company: ${company}
Job Title: ${jobTitle}
Description: ${description}
Preferences: ${preferences}

Provide a JSON response with:
{
  "required_skills": ["skill1", "skill2", ...],
  "preferred_skills": ["skill1", "skill2", ...],
  "work_style": "description",
  "culture_fit": "description",
  "experience_level": "junior/mid/senior",
  "key_requirements": ["req1", "req2", ...]
}`;

    const analysis = await analyzeWithGroq(analysisPrompt);
    let jobData;
    
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      jobData = jsonMatch ? JSON.parse(jsonMatch[0]) : {
        required_skills: [],
        preferred_skills: [],
        work_style: "Not specified",
        culture_fit: "Not specified",
        experience_level: "mid",
        key_requirements: []
      };
    } catch (parseError) {
      jobData = {
        required_skills: [],
        preferred_skills: [],
        work_style: "Not specified",
        culture_fit: "Not specified",
        experience_level: "mid",
        key_requirements: []
      };
    }

    // Insert into Supabase
    const { data, error } = await supabase
      .from('jobs')
      .insert([{
        company,
        email,
        job_title: jobTitle,
        description,
        preferences,
        job_analysis: jobData,
        created_at: new Date().toISOString()
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
app.get('/api/matches/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get job seeker profile
    const { data: seeker, error: seekerError } = await supabase
      .from('job_seekers')
      .select('*')
      .eq('id', userId)
      .single();

    if (seekerError) throw seekerError;

    // Get all jobs
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*');

    if (jobsError) throw jobsError;

    // Match each job with the seeker
    const matches = await Promise.all(jobs.map(async (job) => {
      const matchPrompt = `Score this job match (0-100%):

Job Seeker Profile:
Technical Skills: ${seeker.profile_analysis.technical_skills?.join(', ') || 'Not specified'}
Soft Skills: ${seeker.profile_analysis.soft_skills?.join(', ') || 'Not specified'}
Work Style: ${seeker.profile_analysis.work_style || 'Not specified'}
Experience: ${seeker.profile_analysis.experience_level || 'Not specified'}

Job Requirements:
Company: ${job.company}
Title: ${job.job_title}
Required Skills: ${job.job_analysis.required_skills?.join(', ') || 'Not specified'}
Work Style: ${job.job_analysis.work_style || 'Not specified'}
Experience Needed: ${job.job_analysis.experience_level || 'Not specified'}

Provide a JSON response:
{
  "score": 85,
  "breakdown": "Detailed explanation of the match, highlighting strengths and areas of alignment"
}`;

      const matchResult = await analyzeWithGroq(matchPrompt);
      
      try {
        const jsonMatch = matchResult.match(/\{[\s\S]*\}/);
        const matchData = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 70, breakdown: "Good general fit" };
        
        return {
          jobId: job.id,
          jobTitle: job.job_title,
          company: job.company,
          score: matchData.score || 70,
          breakdown: matchData.breakdown || "Potential match based on profile"
        };
      } catch (parseError) {
        return {
          jobId: job.id,
          jobTitle: job.job_title,
          company: job.company,
          score: 70,
          breakdown: "Potential match based on profile"
        };
      }
    }));

    // Sort by score and filter >= 75%
    const sortedMatches = matches
      .filter(m => m.score >= 75)
      .sort((a, b) => b.score - a.score);

    res.json({ matches: sortedMatches });
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get candidates for job
app.get('/api/candidates/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    // Get job details
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobError) throw jobError;

    // Get all job seekers
    const { data: seekers, error: seekersError } = await supabase
      .from('job_seekers')
      .select('*');

    if (seekersError) throw seekersError;

    // Match each candidate with the job
    const candidates = await Promise.all(seekers.map(async (seeker) => {
      const matchPrompt = `Score this candidate match (0-100%):

Job Requirements:
Company: ${job.company}
Title: ${job.job_title}
Required Skills: ${job.job_analysis.required_skills?.join(', ') || 'Not specified'}
Preferred Skills: ${job.job_analysis.preferred_skills?.join(', ') || 'Not specified'}
Work Style: ${job.job_analysis.work_style || 'Not specified'}
Experience Needed: ${job.job_analysis.experience_level || 'Not specified'}

Candidate Profile:
Name: ${seeker.name}
Technical Skills: ${seeker.profile_analysis.technical_skills?.join(', ') || 'Not specified'}
Soft Skills: ${seeker.profile_analysis.soft_skills?.join(', ') || 'Not specified'}
Work Style: ${seeker.profile_analysis.work_style || 'Not specified'}
Experience: ${seeker.profile_analysis.experience_level || 'Not specified'}

Provide a JSON response:
{
  "score": 85,
  "breakdown": "e.g., '85% - Strong React skills, collaborative mindset, prefers hybrid work. Good culture fit with agile experience.'"
}`;

      const matchResult = await analyzeWithGroq(matchPrompt);
      
      try {
        const jsonMatch = matchResult.match(/\{[\s\S]*\}/);
        const matchData = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 70, breakdown: "Good general fit" };
        
        return {
          candidateId: seeker.id,
          candidateName: seeker.name,
          candidateEmail: seeker.email,
          score: matchData.score || 70,
          breakdown: matchData.breakdown || "Potential candidate based on requirements"
        };
      } catch (parseError) {
        return {
          candidateId: seeker.id,
          candidateName: seeker.name,
          candidateEmail: seeker.email,
          score: 70,
          breakdown: "Potential candidate based on requirements"
        };
      }
    }));

    // Sort by score
    const sortedCandidates = candidates.sort((a, b) => b.score - a.score);

    res.json({ candidates: sortedCandidates });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send message
app.post('/api/message/send', async (req, res) => {
  try {
    const { matchId, message, sender } = req.body;

    const { data, error } = await supabase
      .from('messages')
      .insert([{
        match_id: matchId,
        message,
        sender,
        sent_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;

    res.json({ success: true, messageId: data[0].id });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Swift Jobs API running on port ${PORT}`);
});