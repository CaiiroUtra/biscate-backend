const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const DB_PATH = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());

// ── Ler / Escrever DB ─────────────────────────────────────────
function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}
function generateId() {
  return Date.now().toString();
}

// ── AUTH: Registar ────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name, email, phone, password, role, service, price } = req.body;
  const db = readDB();

  const exists = db.users.find(u => u.email === email || u.phone === phone);
  if (exists) {
    return res.status(409).json({ error: 'Email ou telefone já registado.' });
  }

  const newUser = {
    id: generateId(),
    name, email, phone, password,
    role: role || 'CLIENT',
    verified: false,
    walletBalance: 0,
    escrowBalance: 0,
    ratingAvg: 0,
    ratingCount: 0,
    service: service || '',
    price: parseFloat(price) || 0,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDB(db);

  const { password: _, ...userSafe } = newUser;
  res.status(201).json({ message: 'Conta criada!', user: userSafe });
});

// ── AUTH: Login ───────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDB();

  const user = db.users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ error: 'Email ou senha incorrectos.' });
  }

  const { password: _, ...userSafe } = user;
  res.json({ message: 'Login com sucesso!', user: userSafe });
});

// ── UTILIZADORES: Listar prestadores ─────────────────────────
app.get('/api/freelancers', (req, res) => {
  const db = readDB();
  const { category } = req.query;

  let freelancers = db.users.filter(u => u.role === 'FREELANCER');
  if (category) {
    freelancers = freelancers.filter(u =>
      u.category?.toLowerCase().includes(category.toLowerCase())
    );
  }

  const safe = freelancers.map(({ password, ...u }) => u);
  res.json(safe);
});

// ── UTILIZADORES: Perfil por ID ───────────────────────────────
app.get('/api/users/:id', (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilizador não encontrado.' });
  const { password, ...safe } = user;
  res.json(safe);
});

// ── PORTFÓLIO: Por utilizador ─────────────────────────────────
app.get('/api/portfolio/:userId', (req, res) => {
  const db = readDB();
  const items = db.portfolio.filter(p => p.userId === req.params.userId);
  res.json(items);
});

// ── PORTFÓLIO: Adicionar ──────────────────────────────────────
app.post('/api/portfolio', (req, res) => {
  const db = readDB();
  const newItem = { id: generateId(), ...req.body, createdAt: new Date().toISOString() };
  db.portfolio.push(newItem);
  writeDB(db);
  res.status(201).json(newItem);
});

// ── CONTRATOS: Criar ──────────────────────────────────────────
app.post('/api/contracts', (req, res) => {
  const { clientId, freelancerId, title, amount, description } = req.body;
  const db = readDB();

  const client = db.users.find(u => u.id === clientId);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (client.walletBalance < amount) {
    return res.status(400).json({ error: 'Saldo insuficiente.' });
  }

  // Bloqueia o escrow
  client.walletBalance -= amount;
  client.escrowBalance += amount;

  const autoRelease = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const contract = {
    id: generateId(),
    clientId, freelancerId, title,
    amount: parseFloat(amount),
    description: description || '',
    status: 'ACTIVE',
    escrowLocked: true,
    autoReleaseAt: autoRelease,
    createdAt: new Date().toISOString()
  };

  db.contracts.push(contract);

  // Regista transação
  db.transactions.push({
    id: generateId(),
    userId: clientId,
    type: 'ESCROW_LOCK',
    amount: -amount,
    description: `Escrow bloqueado — contrato ${contract.id}`,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.status(201).json({ message: 'Contrato criado! Pagamento em escrow.', contract });
});

// ── CONTRATOS: Por utilizador ─────────────────────────────────
app.get('/api/contracts/user/:userId', (req, res) => {
  const db = readDB();
  const contracts = db.contracts.filter(
    c => c.clientId === req.params.userId || c.freelancerId === req.params.userId
  );
  res.json(contracts);
});

// ── CONTRATOS: Confirmar entrega (liberta escrow) ─────────────
app.patch('/api/contracts/:id/confirm', (req, res) => {
  const db = readDB();
  const contract = db.contracts.find(c => c.id === req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });

  const freelancer = db.users.find(u => u.id === contract.freelancerId);
  const client     = db.users.find(u => u.id === contract.clientId);

  const total       = contract.amount;
  const platFee     = total * 0.20;
  const freelancerCut = total * 0.80;

  // Liberta escrow
  client.escrowBalance      -= total;
  freelancer.walletBalance  += freelancerCut;

  contract.status      = 'RELEASED';
  contract.escrowLocked = false;
  contract.releasedAt  = new Date().toISOString();

  db.transactions.push({
    id: generateId(),
    userId: contract.freelancerId,
    type: 'ESCROW_RELEASE',
    amount: freelancerCut,
    description: `Pagamento recebido — 80% de MT ${total}`,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.json({ message: 'Entrega confirmada! Pagamento libertado.', freelancerCut, platFee });
});

// ── MENSAGENS: Por contrato ───────────────────────────────────
app.get('/api/messages/:contractId', (req, res) => {
  const db = readDB();
  const msgs = db.messages.filter(m => m.contractId === req.params.contractId);
  res.json(msgs);
});

// ── MENSAGENS: Enviar ─────────────────────────────────────────
app.post('/api/messages', (req, res) => {
  const db = readDB();
  const msg = {
    id: generateId(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  db.messages.push(msg);
  writeDB(db);
  res.status(201).json(msg);
});

// ── TRANSAÇÕES: Por utilizador ────────────────────────────────
app.get('/api/transactions/:userId', (req, res) => {
  const db = readDB();
  const txs = db.transactions
    .filter(t => t.userId === req.params.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(txs);
});

// ── AVALIAÇÕES: Criar ─────────────────────────────────────────
app.post('/api/reviews', (req, res) => {
  const db = readDB();
  const review = {
    id: generateId(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  db.reviews.push(review);

  // Actualiza rating do prestador
  const freelancerReviews = db.reviews.filter(r => r.reviewedId === req.body.reviewedId);
  const avg = freelancerReviews.reduce((s, r) => s + r.rating, 0) / freelancerReviews.length;
  const freelancer = db.users.find(u => u.id === req.body.reviewedId);
  if (freelancer) {
    freelancer.ratingAvg   = Math.round(avg * 10) / 10;
    freelancer.ratingCount = freelancerReviews.length;
  }

  writeDB(db);
  res.status(201).json(review);
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'BISCATE API', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🔨 BISCATE Backend a correr em http://localhost:${PORT}`);
});
