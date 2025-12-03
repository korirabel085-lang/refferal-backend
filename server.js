require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const corsOptions = {
  origin: ['https://luxearn.site', 'https://www.luxearn.site', 'http://luxearn.site', 'http://www.luxearn.site', 'https://luxearnref.onrender.com', 'http://localhost:5500', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

const REFERRAL_LEVELS = {
  1: 16.00,
  2: 3.00,
  3: 2.00
};

function generateReferralCode(email) {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  const numericHash = parseInt(hash.substring(0, 8), 16);
  const code = (numericHash % 900000 + 100000).toString();
  return code;
}

async function findUserByEmail(email) {
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  return result.rows[0] || null;
}

async function findUserByReferralCode(code) {
  const result = await pool.query('SELECT * FROM users WHERE referral_code = $1', [code]);
  return result.rows[0] || null;
}

async function createUser(email, referredByCode = null) {
  const referralCode = generateReferralCode(email);
  const result = await pool.query(
    'INSERT INTO users (email, referral_code, referred_by_code, balance, created_at) VALUES ($1, $2, $3, 0.00, NOW()) RETURNING *',
    [email.toLowerCase().trim(), referralCode, referredByCode]
  );
  return result.rows[0];
}

async function getReferrerChain(userId, maxLevel = 3) {
  const chain = [];
  let currentUserId = userId;
  let level = 0;

  while (level < maxLevel) {
    const result = await pool.query(
      'SELECT u2.* FROM users u1 JOIN users u2 ON u1.referred_by_code = u2.referral_code WHERE u1.id = $1',
      [currentUserId]
    );
    
    if (result.rows.length === 0) break;
    
    level++;
    chain.push({ user: result.rows[0], level });
    currentUserId = result.rows[0].id;
  }

  return chain;
}

async function getTeamByLevel(userId) {
  const team = { level1: [], level2: [], level3: [] };
  
  const user = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) return team;
  
  const userCode = user.rows[0].referral_code;

  const level1 = await pool.query(
    'SELECT id, email, referral_code, created_at FROM users WHERE referred_by_code = $1',
    [userCode]
  );
  team.level1 = level1.rows;

  for (const l1User of level1.rows) {
    const level2 = await pool.query(
      'SELECT id, email, referral_code, created_at FROM users WHERE referred_by_code = $1',
      [l1User.referral_code]
    );
    team.level2.push(...level2.rows);

    for (const l2User of level2.rows) {
      const level3 = await pool.query(
        'SELECT id, email, referral_code, created_at FROM users WHERE referred_by_code = $1',
        [l2User.referral_code]
      );
      team.level3.push(...level3.rows);
    }
  }

  return team;
}

async function calculateReferralEarnings(depositId, userId, amount) {
  const chain = await getReferrerChain(userId);
  
  for (const { user: referrer, level } of chain) {
    const percentage = REFERRAL_LEVELS[level];
    const earningAmount = (amount * percentage) / 100;

    await pool.query(
      `INSERT INTO referral_earnings 
       (referrer_id, referred_user_id, deposit_id, level, percentage, amount, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
      [referrer.id, userId, depositId, level, percentage, earningAmount]
    );
  }
}

app.get('/api/referral', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    let user = await findUserByEmail(email);
    
    if (!user) {
      user = await createUser(email);
    }

    const referralLink = `https://luxearn.site/#/login?ref=${user.referral_code}`;
    
    res.json({
      success: true,
      data: {
        referralCode: user.referral_code,
        referralLink: referralLink,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Error getting referral:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, referralCode } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    let user = await findUserByEmail(email);
    
    if (user) {
      return res.json({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          referralCode: user.referral_code,
          referralLink: `https://luxearn.site/#/login?ref=${user.referral_code}`,
          isNew: false
        }
      });
    }

    let validReferralCode = null;
    if (referralCode) {
      const referrer = await findUserByReferralCode(referralCode);
      if (referrer) {
        validReferralCode = referralCode;
      }
    }

    user = await createUser(email, validReferralCode);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        referralCode: user.referral_code,
        referralLink: `https://luxearn.site/#/login?ref=${user.referral_code}`,
        isNew: true
      }
    });
  } catch (error) {
    console.error('Error registering:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/inviter', async (req, res) => {
  try {
    const { referralCode } = req.query;
    
    if (!referralCode) {
      return res.status(400).json({ success: false, error: 'Referral code is required' });
    }

    const inviter = await findUserByReferralCode(referralCode);
    
    if (!inviter) {
      return res.status(404).json({ success: false, error: 'Inviter not found' });
    }

    const maskedEmail = inviter.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');

    res.json({
      success: true,
      data: {
        maskedEmail: maskedEmail,
        referralCode: inviter.referral_code,
        joinedAt: inviter.created_at
      }
    });
  } catch (error) {
    console.error('Error getting inviter:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/team', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await findUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const team = await getTeamByLevel(user.id);

    const formatMember = (member) => ({
      email: member.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
      joinedAt: member.created_at
    });

    res.json({
      success: true,
      data: {
        level1: {
          count: team.level1.length,
          percentage: REFERRAL_LEVELS[1],
          members: team.level1.map(formatMember)
        },
        level2: {
          count: team.level2.length,
          percentage: REFERRAL_LEVELS[2],
          members: team.level2.map(formatMember)
        },
        level3: {
          count: team.level3.length,
          percentage: REFERRAL_LEVELS[3],
          members: team.level3.map(formatMember)
        },
        totalTeam: team.level1.length + team.level2.length + team.level3.length
      }
    });
  } catch (error) {
    console.error('Error getting team:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

function parseMoney(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[$,]/g, '');
  return parseFloat(cleaned) || 0;
}

app.get('/api/balance', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await findUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const pendingResult = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM referral_earnings WHERE referrer_id = $1 AND status = 'pending'`,
      [user.id]
    );

    const claimedResult = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM referral_earnings WHERE referrer_id = $1 AND status = 'claimed'`,
      [user.id]
    );

    const earningsBreakdown = await pool.query(
      `SELECT level, COALESCE(SUM(amount::numeric), 0) as total 
       FROM referral_earnings 
       WHERE referrer_id = $1 
       GROUP BY level 
       ORDER BY level`,
      [user.id]
    );

    res.json({
      success: true,
      data: {
        pendingBalance: parseFloat(pendingResult.rows[0].total) || 0,
        claimedBalance: parseFloat(claimedResult.rows[0].total) || 0,
        totalBalance: parseMoney(user.balance),
        breakdown: {
          level1: parseFloat(earningsBreakdown.rows.find(r => r.level === 1)?.total) || 0,
          level2: parseFloat(earningsBreakdown.rows.find(r => r.level === 2)?.total) || 0,
          level3: parseFloat(earningsBreakdown.rows.find(r => r.level === 3)?.total) || 0
        }
      }
    });
  } catch (error) {
    console.error('Error getting balance:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/claim', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await findUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const pendingResult = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM referral_earnings WHERE referrer_id = $1 AND status = 'pending'`,
      [user.id]
    );

    const pendingAmount = parseFloat(pendingResult.rows[0].total) || 0;

    if (pendingAmount <= 0) {
      return res.status(400).json({ success: false, error: 'No pending rewards to claim' });
    }

    await pool.query(
      `UPDATE referral_earnings SET status = 'claimed', claimed_at = NOW() WHERE referrer_id = $1 AND status = 'pending'`,
      [user.id]
    );

    await pool.query(
      `UPDATE users SET balance = balance + $1 WHERE id = $2`,
      [pendingAmount, user.id]
    );

    const updatedUser = await findUserByEmail(email);

    res.json({
      success: true,
      data: {
        claimedAmount: pendingAmount,
        newBalance: parseMoney(updatedUser.balance),
        message: `Successfully claimed ${pendingAmount} USDT`
      }
    });
  } catch (error) {
    console.error('Error claiming:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/deposit', async (req, res) => {
  try {
    const { email, amount } = req.body;
    
    if (!email || !amount) {
      return res.status(400).json({ success: false, error: 'Email and amount are required' });
    }

    const user = await findUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const depositResult = await pool.query(
      `INSERT INTO deposits (user_id, amount, status, created_at) VALUES ($1, $2, 'completed', NOW()) RETURNING *`,
      [user.id, amount]
    );

    const deposit = depositResult.rows[0];

    await calculateReferralEarnings(deposit.id, user.id, amount);

    res.json({
      success: true,
      data: {
        depositId: deposit.id,
        amount: amount,
        message: 'Deposit recorded and referral earnings calculated'
      }
    });
  } catch (error) {
    console.error('Error processing deposit:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/earnings-history', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await findUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const earnings = await pool.query(
      `SELECT re.*, u.email as referred_email 
       FROM referral_earnings re 
       JOIN users u ON re.referred_user_id = u.id 
       WHERE re.referrer_id = $1 
       ORDER BY re.created_at DESC 
       LIMIT 50`,
      [user.id]
    );

    const history = earnings.rows.map(e => ({
      level: e.level,
      percentage: e.percentage,
      amount: parseMoney(e.amount),
      status: e.status,
      referredEmail: e.referred_email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
      createdAt: e.created_at,
      claimedAt: e.claimed_at
    }));

    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error getting earnings history:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
