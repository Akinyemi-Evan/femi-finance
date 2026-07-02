require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app = express();
app.use(express.json());

// Allow requests from your dashboard (update this to your actual dashboard URL)
app.use(cors({
  origin: process.env.DASHBOARD_URL || '*',
  credentials: true,
}));

// ── PLAID CLIENT SETUP ──────────────────────────────────────────────────────
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
});
const plaid = new PlaidApi(plaidConfig);

// In-memory token store (Railway persists process memory between requests)
// For production you'd use a database, but for personal use this is fine
const tokenStore = {};

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Femi Finance Server running', env: process.env.PLAID_ENV || 'sandbox' });
});

// ── STEP 1: Create a Link token (opens Plaid's bank connection UI) ──────────
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: 'evan-femi-studios' },
      client_name: 'Femi Finance',
      products: [Products.Transactions, Products.Accounts],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ── STEP 2: Exchange public token for access token (called after bank login) ─
app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Store with institution name as key
    const key = institution_name || item_id;
    tokenStore[key] = { access_token, item_id, institution_name, connected_at: new Date().toISOString() };

    console.log(`Connected: ${institution_name} (${item_id})`);
    res.json({ success: true, item_id, institution_name });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

// ── STEP 3: Get all account balances across all connected institutions ────────
app.get('/api/balances', async (req, res) => {
  try {
    if (Object.keys(tokenStore).length === 0) {
      return res.json({ accounts: [], institutions: [] });
    }

    const allAccounts = [];
    const institutions = [];

    for (const [name, { access_token, institution_name }] of Object.entries(tokenStore)) {
      try {
        const response = await plaid.accountsBalanceGet({ access_token });
        const accounts = response.data.accounts.map(acct => ({
          id:            acct.account_id,
          name:          acct.name,
          official_name: acct.official_name,
          type:          acct.type,          // depository, credit, investment, loan
          subtype:       acct.subtype,       // checking, savings, credit card, etc.
          balance:       acct.balances.current,
          available:     acct.balances.available,
          limit:         acct.balances.limit,
          currency:      acct.balances.iso_currency_code,
          institution:   institution_name || name,
        }));
        allAccounts.push(...accounts);
        institutions.push(institution_name || name);
      } catch (instErr) {
        console.error(`Balance error for ${name}:`, instErr.response?.data || instErr.message);
        // Don't fail entire request if one institution errors
        institutions.push(`${name} (error)`);
      }
    }

    res.json({ accounts: allAccounts, institutions });
  } catch (err) {
    console.error('balances error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STEP 4: Get recent transactions (last 30 days) ───────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    if (Object.keys(tokenStore).length === 0) {
      return res.json({ transactions: [] });
    }

    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const allTx = [];

    for (const [name, { access_token }] of Object.entries(tokenStore)) {
      try {
        const response = await plaid.transactionsGet({
          access_token,
          start_date: startDate,
          end_date: endDate,
          options: { count: 100 },
        });
        const txs = response.data.transactions.map(tx => ({
          id:          tx.transaction_id,
          date:        tx.date,
          desc:        tx.merchant_name || tx.name,
          amount:      -tx.amount, // Plaid: positive = debit. We flip for display.
          category:    mapCategory(tx.personal_finance_category?.primary || tx.category?.[0] || 'Other'),
          account:     tx.account_id,
          institution: name,
        }));
        allTx.push(...txs);
      } catch (instErr) {
        console.error(`Transactions error for ${name}:`, instErr.response?.data || instErr.message);
      }
    }

    // Sort newest first
    allTx.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ transactions: allTx });
  } catch (err) {
    console.error('transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List connected institutions ──────────────────────────────────────────────
app.get('/api/institutions', (req, res) => {
  const list = Object.entries(tokenStore).map(([key, val]) => ({
    key,
    institution_name: val.institution_name,
    item_id: val.item_id,
    connected_at: val.connected_at,
  }));
  res.json({ institutions: list, count: list.length });
});

// ── Remove a connected institution ──────────────────────────────────────────
app.delete('/api/institutions/:key', async (req, res) => {
  const { key } = req.params;
  if (tokenStore[key]) {
    try {
      await plaid.itemRemove({ access_token: tokenStore[key].access_token });
    } catch (e) { /* best effort */ }
    delete tokenStore[key];
    res.json({ success: true, removed: key });
  } else {
    res.status(404).json({ error: 'Institution not found' });
  }
});

// ── Category mapper ──────────────────────────────────────────────────────────
function mapCategory(plaidCategory) {
  const map = {
    'FOOD_AND_DRINK':        'Food & Dining',
    'TRANSPORTATION':        'Transport',
    'TRAVEL':                'Transport',
    'SHOPS':                 'Shopping',
    'SHOPPING':              'Shopping',
    'ENTERTAINMENT':         'Entertainment',
    'RECREATION':            'Entertainment',
    'HEALTHCARE':            'Health',
    'HEALTH':                'Health',
    'UTILITIES':             'Utilities',
    'SERVICE':               'Utilities',
    'RENT_AND_UTILITIES':    'Utilities',
    'SUBSCRIPTION':          'Subscriptions',
    'GENERAL_SERVICES':      'Other',
    'TRANSFER_IN':           'Transfer',
    'TRANSFER_OUT':          'Transfer',
    'LOAN_PAYMENTS':         'Loan Payment',
    'GENERAL_MERCHANDISE':   'Shopping',
    'HOME_IMPROVEMENT':      'Shopping',
    'PERSONAL_CARE':         'Health',
    'GOVERNMENT_AND_NON_PROFIT': 'Other',
    'INCOME':                'Income',
  };
  for (const [key, val] of Object.entries(map)) {
    if (plaidCategory.toUpperCase().includes(key)) return val;
  }
  return 'Other';
}

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Femi Finance Server running on port ${PORT}`);
  console.log(`Plaid environment: ${process.env.PLAID_ENV || 'sandbox'}`);
});
