import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const {
  JIRA_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  PORT = 3000,
  CACHE_TTL_SECONDS = 300,
  PLATFORM_DETECTION = 'true',
} = process.env;

const cacheTTL = Number(CACHE_TTL_SECONDS) * 1000;
const platformDetection = PLATFORM_DETECTION !== 'false';

const issueCache = new Map(); // projectKey → { data, ts }
let projectsCache = { data: null, ts: 0 };

function getAuth() {
  return Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

function detectPlatform(summary = '') {
  if (/\bWEB\b/i.test(summary)) return 'Web';
  if (/\bAndroid\b/i.test(summary)) return 'Android';
  if (/\biOS?\b|IOS\b/i.test(summary)) return 'iOS';
  return 'General';
}

function normalizeDate(val) {
  if (!val) return null;
  return val.slice(0, 10);
}

async function fetchProjects() {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Faltan variables de entorno: JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  }
  const res = await fetch(`${JIRA_URL}/rest/api/3/project`, {
    headers: { Authorization: `Basic ${getAuth()}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }
  const projects = await res.json();
  return projects
    .map(p => ({ key: p.key, name: p.name, type: p.projectTypeKey }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchAllIssues(projectKey) {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Faltan variables de entorno: JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  }

  const jql = `project = ${projectKey} ORDER BY updated DESC`;
  const authHeaders = { Authorization: `Basic ${getAuth()}`, Accept: 'application/json' };
  const fields = [
    'summary', 'issuetype', 'status', 'assignee', 'priority',
    'created', 'updated', 'duedate', 'customfield_10015', 'labels', 'resolution',
  ];

  let issues = [];
  let nextPageToken = undefined;
  const maxResults = 100;

  while (true) {
    const body = { jql, fields, maxResults };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API error ${res.status}: ${text}`);
    }

    const json = await res.json();
    issues = issues.concat(json.issues);
    if (!json.nextPageToken || json.issues.length === 0) break;
    nextPageToken = json.nextPageToken;
  }

  return issues.map((issue) => {
    const f = issue.fields;
    return {
      key: issue.key,
      summary: f.summary,
      type: f.issuetype?.name ?? 'Desconocido',
      status: f.status?.name ?? 'Desconocido',
      assignee: f.assignee?.displayName ?? 'Sin asignar',
      priority: f.priority?.name ?? 'Sin prioridad',
      created: normalizeDate(f.created),
      updated: normalizeDate(f.updated),
      duedate: normalizeDate(f.duedate),
      startDate: normalizeDate(f.customfield_10015),
      labels: f.labels ?? [],
      resolution: f.resolution?.name ?? null,
      platform: platformDetection ? detectPlatform(f.summary) : null,
    };
  });
}

// Static files
app.use(express.static(join(__dirname, 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    jiraConfigured: !!(JIRA_URL && JIRA_EMAIL && JIRA_API_TOKEN),
    platformDetection,
    cachedProjects: issueCache.size,
  });
});

// Projects list
app.get('/api/projects', async (_req, res) => {
  try {
    const now = Date.now();
    if (projectsCache.data && now - projectsCache.ts < cacheTTL) {
      return res.json(projectsCache.data);
    }
    const projects = await fetchProjects();
    projectsCache = { data: projects, ts: now };
    res.json(projects);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Issues by project
app.get('/api/issues', async (req, res) => {
  const projectKey = req.query.project;
  if (!projectKey) {
    return res.status(400).json({ error: 'Se requiere el parámetro ?project=KEY' });
  }
  try {
    const now = Date.now();
    const cached = issueCache.get(projectKey);
    if (cached && now - cached.ts < cacheTTL) {
      return res.json(cached.data);
    }
    const issues = await fetchAllIssues(projectKey);
    issueCache.set(projectKey, { data: issues, ts: now });
    res.json(issues);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard Jira corriendo en http://localhost:${PORT}`);
  console.log(`Jira: ${JIRA_URL || '(no configurado)'}`);
});
