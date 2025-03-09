const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

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
  }

  startServer(serverId, serverPath) {
    return new Promise((resolve, reject) => {
      if (this.processes.has(serverId)) {
        return reject('Server already running');
      }

      const batPath = path.join(serverPath, 'run.bat');
      const child = spawn('cmd.exe', ['/c', batPath], {
        cwd: serverPath,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.processes.set(serverId, child);

      child.stdout.on('data', (data) => {
        console.log(`[${serverId}] ${data.toString()}`);
      });

      child.stderr.on('data', (data) => {
        console.error(`[${serverId}] ${data.toString()}`);
      });

      child.on('exit', (code) => {
        this.processes.delete(serverId);
        db.run(
          'UPDATE servers SET status = ? WHERE id = ?',
          ['stopped', serverId]
        );
      });

      setTimeout(() => {
        db.run(
          'UPDATE servers SET status = ? WHERE id = ?',
          ['running', serverId]
        );
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
      } else {
        resolve();
      }
    });
  }
}

const serverManager = new ServerManager();

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
  try {
    if (!fs.existsSync(FORGE_TEMPLATE)) {
      throw new Error('Server template not configured');
    }

    await fs.copy(FORGE_TEMPLATE, serverPath);
    
    const propertiesPath = path.join(serverPath, 'server.properties');
    let properties = await fs.readFile(propertiesPath, 'utf8');
    properties = properties
      .replace(/motd=.*/, `motd=${serverName}`)
      .replace(/server-port=.*/, `server-port=${serverPort}`);
    await fs.writeFile(propertiesPath, properties);

  } catch (err) {
    throw new Error(`Template setup failed: ${err.message}`);
  }
}

// API Endpoints
app.get('/api/servers', (req, res) => {
  db.all('SELECT * FROM servers', (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Failed to load servers' });
    }
    res.json(rows);
  });
});

app.post('/api/servers', async (req, res) => {
  const { name, port = 25565 } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Server name is required' });
  }

  let folderName = sanitizeFolderName(name);
  let serverPath = path.join(SERVERS_DIR, folderName);
  let counter = 1;

  while (await fs.pathExists(serverPath)) {
    folderName = `${sanitizeFolderName(name)}-${counter}`;
    serverPath = path.join(SERVERS_DIR, folderName);
    counter++;
  }

  const serverId = uuidv4();

  try {
    await fs.mkdir(serverPath, { recursive: true });
    await copyTemplate(serverPath, name, port);

    db.run(
      `INSERT INTO servers 
      (id, name, folder_name, minecraft_version, forge_version, port, path) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [serverId, name, folderName, '1.20.1', '47.2.0', port, serverPath],
      function(err) {
        if (err) {
          console.error('Database error:', err.message);
          return res.status(500).json({ error: 'Database operation failed' });
        }
        res.json({ success: true, id: serverId });
      }
    );

  } catch (err) {
    if (await fs.pathExists(serverPath)) {
      await fs.remove(serverPath);
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM servers WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (await fs.pathExists(server.path)) {
      await fs.remove(server.path);
    }

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM servers WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ success: true });

  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

app.post('/api/servers/:id/start', async (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM servers WHERE id = ?', [id], async (err, server) => {
    if (err || !server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    try {
      await serverManager.startServer(server.id, server.path);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

app.post('/api/servers/:id/stop', async (req, res) => {
  const { id } = req.params;

  try {
    await serverManager.stopServer(id);
    db.run(
      'UPDATE servers SET status = ? WHERE id = ?',
      ['stopped', id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});