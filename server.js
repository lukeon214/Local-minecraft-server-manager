const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const app = express();
const port = 3000;
const SERVERS_DIR = path.join(__dirname, 'servers');
const FORGE_TEMPLATE = path.join(__dirname, 'forge_template');

// Database setup
const db = new sqlite3.Database('./database/servers.db', (err) => {
  if (err) {
    console.error('Database error:', err.message);
    process.exit(1);
  }
});

// Database schema setup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    minecraft_version TEXT NOT NULL,
    forge_version TEXT NOT NULL,
    port INTEGER NOT NULL,
    status TEXT DEFAULT 'stopped',
    path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Server process manager
class ServerManager {
  constructor() {
    this.processes = new Map();
    this.consoles = new Map();
  }

  startServer(serverId, serverPath) {
    return new Promise((resolve, reject) => {
      if (this.processes.has(serverId)) return reject('Server already running');

      this.consoles.set(serverId, []);
      const batPath = path.join(serverPath, 'run.bat');
      const child = spawn('cmd.exe', ['/c', batPath], {
        cwd: serverPath,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.processes.set(serverId, child);

      child.stdout.on('data', (data) => this._handleOutput(serverId, data.toString()));
      child.stderr.on('data', (data) => this._handleOutput(serverId, `[ERROR] ${data.toString()}`));
      child.on('exit', (code) => this._handleExit(serverId, code));

      setTimeout(() => {
        db.run('UPDATE servers SET status = ? WHERE id = ?', ['running', serverId]);
        resolve();
      }, 2000);
    });
  }

  stopServer(serverId) {
    return new Promise((resolve) => {
      const process = this.processes.get(serverId);
      if (process) {
        process.stdin.write('stop\n');
        setTimeout(() => {
          if (!process.killed) process.kill();
          resolve();
        }, 5000);
      } else resolve();
    });
  }

  getConsoleHistory(serverId) {
    return this.consoles.get(serverId) || [];
  }

  _handleOutput(serverId, output) {
    this.consoles.set(serverId, [...this.consoles.get(serverId) || [], output]);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.serverId === serverId) {
        client.send(JSON.stringify({ type: 'output', data: output }));
      }
    });
  }

  _handleExit(serverId, code) {
    this.processes.delete(serverId);
    db.run('UPDATE servers SET status = ? WHERE id = ?', ['stopped', serverId]);
    this._handleOutput(serverId, `Server process exited with code ${code}\n`);
  }
}

const serverManager = new ServerManager();
const wss = new WebSocket.Server({ noServer: true });

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions
function sanitizeFolderName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 30);
}

async function copyTemplate(serverPath, serverName, serverPort) {
  if (!fs.existsSync(FORGE_TEMPLATE)) throw new Error('Server template not configured');
  await fs.copy(FORGE_TEMPLATE, serverPath);
  
  const propertiesPath = path.join(serverPath, 'server.properties');
  const properties = await fs.readFile(propertiesPath, 'utf8')
    .then(content => content
      .replace(/motd=.*/, `motd=${serverName}`)
      .replace(/server-port=.*/, `server-port=${serverPort}`));
  await fs.writeFile(propertiesPath, properties);
}

// API Endpoints
app.get('/api/servers', (req, res) => {
  db.all('SELECT * FROM servers', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load servers' });
    res.json(rows);
  });
});

app.post('/api/servers', async (req, res) => {
  try {
    const { name, port = 25565 } = req.body;
    if (!name) return res.status(400).json({ error: 'Server name required' });

    let folderName = sanitizeFolderName(name);
    let serverPath = path.join(SERVERS_DIR, folderName);
    let counter = 1;

    while (await fs.pathExists(serverPath)) {
      serverPath = path.join(SERVERS_DIR, `${sanitizeFolderName(name)}-${counter++}`);
    }

    const serverId = uuidv4();
    await fs.mkdir(serverPath, { recursive: true });
    await copyTemplate(serverPath, name, port);

    db.run(
      `INSERT INTO servers (id, name, folder_name, minecraft_version, forge_version, port, path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [serverId, name, path.basename(serverPath), '1.20.1', '47.2.0', port, serverPath],
      (err) => {
        if (err) {
          console.error('Insert error:', err); // Log the error for debugging
          return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, id: serverId });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM servers WHERE id = ?', [req.params.id], (err, row) => 
        err ? reject(err) : resolve(row))
    });

    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (await fs.pathExists(server.path)) await fs.remove(server.path);
    
    await new Promise((resolve, reject) => 
      db.run('DELETE FROM servers WHERE id = ?', [req.params.id], err => 
        err ? reject(err) : resolve()));
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

// Server control endpoints
app.post('/api/servers/:id/start', async (req, res) => {
  const server = await new Promise(resolve => 
    db.get('SELECT * FROM servers WHERE id = ?', [req.params.id], (err, row) => resolve(row)));
  
  if (!server) return res.status(404).json({ error: 'Server not found' });
  
  try {
    await serverManager.startServer(server.id, server.path);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/stop', async (req, res) => {
  try {
    await serverManager.stopServer(req.params.id);
    db.run('UPDATE servers SET status = ? WHERE id = ?', ['stopped', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers/:id', (req, res) => {
  db.get('SELECT * FROM servers WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(404).json({ error: 'Server not found' });
    res.json(row);
  });
});

// WebSocket setup
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  const serverId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('serverId');
  ws.serverId = serverId;
  ws.send(JSON.stringify({ 
    type: 'history', 
    data: serverManager.getConsoleHistory(serverId) 
  }));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});