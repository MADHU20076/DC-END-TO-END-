const express = require('express');
const http = require('http');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================== DATA DIR ==================
const DATA_DIR = '/app/data';
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`✅ Data dir: ${DATA_DIR}`);
} catch (e) {
    console.log(`⚠️ Data dir error: ${e.message}`);
}

// ================== CRASH PREVENTION ==================
process.on('unhandledRejection', (err) => {
    console.log('[UNHANDLED]', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.log('[UNCAUGHT]', err?.message || err);
});
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received. Saving tasks...');
    try { saveTasksToDisk(); } catch (e) {}
    for (const [id, t] of activeTasks.entries()) {
        t.isRunning = false;
        if (t.context) await safeCloseContext(t.context);
    }
    process.exit(0);
});
process.on('SIGINT', async () => {
    try { saveTasksToDisk(); } catch (e) {}
    process.exit(0);
});

// ================== CONFIG ==================
const BROWSER_RESTART_INTERVAL = 12 * 60 * 60 * 1000;   // 12 hours
const PAGE_RELOAD_EVERY = 30;
const MEMORY_LIMIT_MB = 950;                             // 950 MB (unnecessary restart rokne ke liye)
const CONTEXT_CLOSE_TIMEOUT = 20000;
const BROWSER_LAUNCH_TIMEOUT = 60000;
const RESTART_MAX_RETRIES = 5;
const RESTART_RETRY_DELAY = 10000;
const SESSION_CHECK_EVERY = 3;
const WATCHDOG_TIMEOUT = 15 * 60 * 1000;
const RELOGIN_MAX_RETRIES = 3;
const NETWORK_RETRY_ATTEMPTS = 5;

// ================== ACTIVE TASKS ==================
const activeTasks = new Map();
const sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000));

// ================== HELPERS ==================
function parseCookies(cookieStr) {
    const result = [];
    const seen = new Set();
    
    cookieStr.split(';').forEach(pair => {
        const [name, ...rest] = pair.trim().split('=');
        if (!name || rest.length === 0) return;
        const value = rest.join('=').trim();
        const cookieName = name.trim();
        
        ['.facebook.com', '.messenger.com'].forEach(domain => {
            const key = `${cookieName}|${domain}`;
            if (seen.has(key)) return;
            seen.add(key);
            result.push({
                name: cookieName,
                value: value,
                domain: domain,
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'Lax'
            });
        });
    });
    
    return result;
}

function killZombieChromium() {
    try {
        execSync('pkill -9 -f "chrome|chromium" || true', { stdio: 'ignore' });
        console.log('🧹 Zombie Chromium killed');
    } catch(e) {}
}

async function safeCloseContext(context) {
    if (!context) return;
    try {
        await Promise.race([
            context.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), CONTEXT_CLOSE_TIMEOUT))
        ]);
    } catch(e) {
        console.log('Context close error:', e.message);
    }
}

// ================== SESSION ALIVE CHECK ==================
async function isSessionAlive(page) {
    try {
        if (!page || page.isClosed()) {
            return { alive: false, reason: 'Page closed' };
        }
        
        const url = page.url();
        if (url.includes('/login') || url.includes('checkpoint') || 
            url.includes('/recover') || url.includes('/help/contact')) {
            return { alive: false, reason: `URL redirect: ${url}` };
        }
        
        const title = await page.title().catch(() => '');
        const titleLower = title.toLowerCase();
        if (titleLower.includes('log in') || titleLower.includes('sign in') || 
            titleLower.includes('login')) {
            return { alive: false, reason: `Login title: ${title}` };
        }
        
        const inputBox = await page.$('div[contenteditable="true"][role="textbox"], div[contenteditable="true"]').catch(() => null);
        if (!inputBox) {
            return { alive: false, reason: 'Input box missing' };
        }
        
        const loginBtn = await page.$('button:has-text("Log in"), a:has-text("Log in"), div[role="button"]:has-text("Log in")').catch(() => null);
        if (loginBtn) {
            return { alive: false, reason: 'Login button detected' };
        }
        
        const pwdField = await page.$('input[type="password"]').catch(() => null);
        if (pwdField) {
            return { alive: false, reason: 'Password field detected' };
        }
        
        return { alive: true };
    } catch (e) {
        return { alive: false, reason: `Check error: ${e.message}` };
    }
}

// ================== SAVE / LOAD TASKS ==================
function saveTasksToDisk() {
    try {
        const tasksToSave = {};
        for (const [taskId, task] of activeTasks.entries()) {
            if (task.originalData && task.isRunning) {
                tasksToSave[taskId] = task.originalData;
            }
        }
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksToSave, null, 2));
        console.log(`💾 Saved ${Object.keys(tasksToSave).length} task(s)`);
        return true;
    } catch (e) {
        console.log('❌ Save error:', e.message);
        return false;
    }
}

async function loadTasksFromDisk() {
    try {
        if (!fs.existsSync(TASKS_FILE)) {
            console.log('📂 No saved tasks. Fresh start.');
            return;
        }
        const fileContent = fs.readFileSync(TASKS_FILE, 'utf8');
        if (!fileContent.trim()) return;
        
        const tasksData = JSON.parse(fileContent);
        const taskIds = Object.keys(tasksData);
        if (taskIds.length === 0) {
            console.log('📂 No tasks to resume.');
            return;
        }
        
        console.log(`🔄 Auto-resuming ${taskIds.length} task(s)...`);
        
        for (const [taskId, data] of Object.entries(tasksData)) {
            console.log(`🚀 Resuming: ${taskId}`);
            const taskData = {
                taskId,
                isRunning: true,
                startedAt: data.startedAt || Date.now(),
                logs: [`[${new Date().toLocaleTimeString()}] 🔄 Auto-resumed after restart`],
                context: null,
                originalData: data
            };
            activeTasks.set(taskId, taskData);
            await sleep(2);
            runPlaywrightBot(taskId, data.cookies, data.threadId, data.e2eePin, data.prefix, data.messages, data.delay)
                .catch(err => {
                    console.log(`[CRASH ${taskId}]`, err.message);
                    const t = activeTasks.get(taskId);
                    if (t) {
                        t.isRunning = false;
                        t.logs.push(`[${new Date().toLocaleTimeString()}] [FATAL] ${err.message}`);
                    }
                });
        }
        console.log('✅ Auto-resume complete.');
    } catch (e) {
        console.log('❌ Load error:', e.message);
    }
}

// ================== PERSISTENT BROWSER LAUNCH ==================
async function launchPersistentBrowser(taskId, cookiesStr, addLog, forceFresh = false) {
    const userDataDir = path.join(DATA_DIR, `browser-profile-${taskId}`);
    const backupDir = path.join(DATA_DIR, `browser-profile-${taskId}-backup`);
    
    let isFreshProfile = true;
    try {
        if (fs.existsSync(userDataDir) && !forceFresh) {
            const files = fs.readdirSync(userDataDir);
            if (files.includes('Default') || files.includes('Local State')) {
                isFreshProfile = false;
            }
        }
    } catch(e) {}
    
    if (forceFresh && fs.existsSync(userDataDir)) {
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            addLog(`🗑️ Old profile deleted (force fresh)`);
        } catch(e) {}
    }
    
    if (isFreshProfile) {
        addLog(`🆕 Fresh browser profile. Cookies inject ho rahi hain...`);
    } else {
        addLog(`🔄 Existing profile. Saved session use hoga.`);
    }
    
    if (!isFreshProfile && fs.existsSync(userDataDir)) {
        try {
            if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
            execSync(`cp -r "${userDataDir}" "${backupDir}"`, { stdio: 'ignore' });
        } catch(e) {}
    }
    
    const launchPromise = chromium.launchPersistentContext(userDataDir, {
        headless: true,
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
        acceptDownloads: false,
        ignoreHTTPSErrors: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-pings',
            '--password-store=basic',
            '--use-mock-keychain',
            '--memory-pressure-off'
        ]
    });
    
    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Browser launch timeout')), BROWSER_LAUNCH_TIMEOUT)
    );
    
    const context = await Promise.race([launchPromise, timeoutPromise]);
    
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
    
    if (isFreshProfile) {
        await context.addCookies(parseCookies(cookiesStr));
        addLog(`✅ Cookies injected (${parseCookies(cookiesStr).length} cookies)`);
    } else {
        addLog(`✅ Saved session loaded from profile`);
    }
    
    return { context, isFreshProfile };
}

// ================== DASHBOARD UI ==================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="hi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger Auto Tool - Th3 Legend boy Raj  Baba</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #fce7f3 0%, #ffffff 100%); color: #1f2937; padding: 20px; margin: 0; min-height: 100vh; }
        .container { max-width: 720px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #fbcfe8; box-shadow: 0 12px 30px rgba(236, 72, 153, 0.15); }
        h2 { text-align: center; color: #db2777; margin-bottom: 5px; font-size: 26px; }
        .developer-tag { text-align: center; color: #6b7280; font-size: 13px; font-weight: bold; margin-bottom: 25px; letter-spacing: 1px; }
        label { font-weight: 600; margin-top: 15px; display: block; color: #4b5563; font-size: 14px; }
        input, textarea { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid #d1d5db; background: #fdf2f8; color: #1f2937; font-size: 14px; }
        input:focus, textarea:focus { border-color: #ec4899; outline: none; background: #fff; box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.1); }
        textarea { height: 90px; resize: vertical; }
        .btn-start { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; width: 100%; margin-top: 25px; padding: 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 12px rgba(219, 39, 119, 0.3); }
        .btn-stop { background: #ef4444; color: white; padding: 12px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; white-space: nowrap; }
        .btn-view { background: #8b5cf6; color: white; padding: 12px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; white-space: nowrap; }
        .btn-check { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; }
        .btn-check:disabled { opacity: 0.6; cursor: not-allowed; }
        .row { display: flex; gap: 10px; align-items: flex-end; margin-top: 10px; }
        .row input { margin-top: 0; }
        .monitor-card { margin-top: 25px; padding: 20px; background: linear-gradient(135deg, #fdf2f8 0%, #ffffff 100%); border: 2px solid #fbcfe8; border-radius: 12px; }
        .monitor-card h3 { color: #db2777; margin: 0 0 15px 0; font-size: 16px; }
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 15px; }
        .stat-box { background: #fff; padding: 12px; border-radius: 8px; border: 1px solid #fbcfe8; }
        .stat-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; }
        .stat-value { font-size: 18px; color: #db2777; font-weight: bold; margin-top: 4px; font-family: monospace; }
        #logBox { background: #111827; padding: 15px; height: 250px; overflow-y: auto; border-radius: 8px; font-family: monospace; font-size: 12px; border: 1px solid #374151; color: #4ade80; }
        #logBox .err { color: #f87171; }
        #logBox .warn { color: #fbbf24; }
        .divider { margin: 25px 0; border-top: 2px dashed #f3f4f6; }
        .info-banner { background: #ecfdf5; border: 1px solid #6ee7b7; padding: 10px; border-radius: 8px; font-size: 13px; color: #065f46; margin-top: 15px; }
        .cookie-result-box { padding: 12px; border-radius: 8px; font-size: 13px; font-family: monospace; line-height: 1.5; margin-top: 10px; }
        .cookie-result-box.valid { background: #ecfdf5; border: 1px solid #10b981; color: #065f46; }
        .cookie-result-box.invalid { background: #fef2f2; border: 1px solid #ef4444; color: #991b1b; }
        .cookie-result-box.loading { background: #eff6ff; border: 1px solid #3b82f6; color: #1e40af; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Messenger Automation Bot</h2>
        <div class="developer-tag">DEVELOPED BY : R4j Baba</div>
        <div class="info-banner">♻️ 12h Restart | 950MB Safe | Persistent Profile + Auto-Relogin</div>
        
        <form id="botForm">
            <label>Messenger Cookie String:</label>
            <textarea id="cookies" placeholder="c_user=...; xs=...; datr=...;" required></textarea>
            <div class="row" style="margin-top: 8px;">
                <button type="button" class="btn-check" id="checkBtn" onclick="checkCookies()">🔍 CHECK COOKIES</button>
            </div>
            <div id="cookieResult"></div>
            <label>Target UID / Thread ID:</label>
            <input type="text" id="threadId" placeholder="e.g. 1000XXXXXXXXX" required>
            <label>E2EE 6-Digit PIN (Optional):</label>
            <input type="password" id="e2eePin" placeholder="e.g. 123456">
            <label>Message Prefix (Optional):</label>
            <input type="text" id="prefix" placeholder="e.g. [RAJ]">
            <label>Messages (.txt File):</label>
            <input type="file" id="msgFile" accept=".txt" required>
            <label>Delay (In Seconds):</label>
            <input type="number" id="delay" value="120" min="5" required>
            <button type="button" class="btn-start" onclick="startTask()">START TASK</button>
        </form>
        <div class="divider"></div>
        <div class="monitor-card">
            <h3>📊 Task Monitor</h3>
            <label>Task ID:</label>
            <div class="row">
                <input type="text" id="monitorTaskId" placeholder="e.g. TASK-123456">
                <button type="button" class="btn-view" onclick="viewTask()">VIEW</button>
                <button type="button" class="btn-stop" onclick="stopTask()">STOP</button>
            </div>
            <div class="stats-grid" style="margin-top: 15px;">
                <div class="stat-box"><div class="stat-label">Status</div><div class="stat-value" id="statusBadge">—</div></div>
                <div class="stat-box"><div class="stat-label">Uptime</div><div class="stat-value" id="uptime">—</div></div>
            </div>
            <div id="logBox">Waiting for task ID...</div>
        </div>
    </div>
    <script>
        let monitorTaskId = null, pollInterval = null, startedAt = null;
        function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
        async function checkCookies() {
            const cookies = document.getElementById('cookies').value.trim();
            const btn = document.getElementById('checkBtn');
            const resultDiv = document.getElementById('cookieResult');
            if (!cookies) { resultDiv.innerHTML = '<div class="cookie-result-box invalid">❌ Pehle cookies daalo!</div>'; return; }
            btn.disabled = true; btn.innerHTML = '⏳ Checking...';
            resultDiv.innerHTML = '<div class="cookie-result-box loading">🔄 Check ho raha hai...</div>';
            try {
                const res = await fetch('/api/check-cookies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies }) });
                const data = await res.json();
                if (data.valid) {
                    resultDiv.innerHTML = '<div class="cookie-result-box valid">✅ <b>Valid!</b><br>👤 ' + (data.user_id || 'N/A') + '<br>📛 ' + (data.user_name || 'Unknown') + '</div>';
                } else {
                    resultDiv.innerHTML = '<div class="cookie-result-box invalid">❌ <b>Invalid!</b><br>' + (data.error || '') + '</div>';
                }
            } catch (err) { resultDiv.innerHTML = '<div class="cookie-result-box invalid">❌ ' + err.message + '</div>'; }
            finally { btn.disabled = false; btn.innerHTML = '🔍 CHECK COOKIES'; }
        }
        async function startTask() {
            const cookies = document.getElementById('cookies').value.trim();
            const threadId = document.getElementById('threadId').value.trim();
            const e2eePin = document.getElementById('e2eePin').value.trim();
            const prefix = document.getElementById('prefix').value;
            const delay = parseInt(document.getElementById('delay').value);
            const fileInput = document.getElementById('msgFile');
            if (!cookies || !threadId || fileInput.files.length === 0) { alert('Sab fields bharein!'); return; }
            const text = await fileInput.files[0].text();
            const messages = text.split('\\n').map(m => m.trim()).filter(m => m.length > 0);
            if (messages.length === 0) { alert('File khali hai!'); return; }
            const response = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies, threadId, e2eePin, prefix, messages, delay }) });
            const data = await response.json();
            if (data.success) { document.getElementById('monitorTaskId').value = data.taskId; viewTask(); }
            else alert("Start fail!");
        }
        function viewTask() {
            const taskId = document.getElementById('monitorTaskId').value.trim();
            if (!taskId) { alert('Task ID daalein!'); return; }
            monitorTaskId = taskId; startedAt = null;
            document.getElementById('statusBadge').innerHTML = '—';
            document.getElementById('uptime').innerHTML = '—';
            document.getElementById('logBox').innerHTML = 'Loading...';
            if (pollInterval) clearInterval(pollInterval);
            fetchStatus();
            pollInterval = setInterval(fetchStatus, 2000);
        }
        async function fetchStatus() {
            if (!monitorTaskId) return;
            try {
                const res = await fetch('/api/status/' + monitorTaskId);
                const data = await res.json();
                if (!data.found) {
                    document.getElementById('statusBadge').innerHTML = '❌ Not Found';
                    document.getElementById('logBox').innerHTML = 'Task not found';
                    return;
                }
                startedAt = data.startedAt;
                document.getElementById('statusBadge').innerHTML = data.isRunning ? '🟢 Running' : '🔴 Stopped';
                const logBox = document.getElementById('logBox');
                logBox.innerHTML = data.logs.map(l => {
                    let cls = '';
                    if (l.includes('FATAL') || l.includes('Error') || l.includes('❌')) cls = 'err';
                    else if (l.includes('⚠️') || l.includes('Warning')) cls = 'warn';
                    return '<div class="' + cls + '">' + escapeHtml(l) + '</div>';
                }).join('');
                logBox.scrollTop = logBox.scrollHeight;
            } catch(e) {}
        }
        async function stopTask() {
            const taskId = document.getElementById('monitorTaskId').value.trim();
            if (!taskId) { alert('Task ID daalein!'); return; }
            if (!confirm('Stop ' + taskId + '?')) return;
            await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }) });
            fetchStatus();
        }
        setInterval(() => {
            if (!startedAt) return;
            const elapsed = Date.now() - startedAt;
            const d = Math.floor(elapsed / 86400000);
            const h = Math.floor((elapsed % 86400000) / 3600000);
            const m = Math.floor((elapsed % 3600000) / 60000);
            const s = Math.floor((elapsed % 60000) / 1000);
            document.getElementById('uptime').innerHTML = d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ================== COOKIE CHECKER API ==================
app.post('/api/check-cookies', async (req, res) => {
    const { cookies } = req.body;
    if (!cookies || cookies.trim().length === 0) return res.json({ valid: false, error: 'Cookies khali!' });
    
    let context = null;
    try {
        const parsedCookies = parseCookies(cookies);
        const cUserCookie = parsedCookies.find(c => c.name === 'c_user');
        const xsCookie = parsedCookies.find(c => c.name === 'xs');
        
        if (!cUserCookie || !xsCookie) {
            return res.json({ valid: false, error: 'c_user ya xs missing' });
        }
        
        const userId = cUserCookie.value;
        const checkProfileDir = path.join(DATA_DIR, 'cookie-check-temp');
        try { if (fs.existsSync(checkProfileDir)) fs.rmSync(checkProfileDir, { recursive: true, force: true }); } catch(e) {}
        
        context = await chromium.launchPersistentContext(checkProfileDir, {
            headless: true,
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        
        await context.addCookies(parsedCookies);
        const page = await context.newPage();
        await page.goto('https://www.messenger.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(5000);
        
        const currentUrl = page.url();
        const isLoggedIn = !currentUrl.includes('/login') && !currentUrl.includes('checkpoint') && !currentUrl.includes('/recover');
        
        if (!isLoggedIn) {
            await safeCloseContext(context);
            try { fs.rmSync(checkProfileDir, { recursive: true, force: true }); } catch(e) {}
            return res.json({ valid: false, error: 'Login page redirect', redirect_url: currentUrl, user_id: userId });
        }
        
        let userName = 'Unknown';
        try {
            const el = await page.$('div[aria-label*="Account"] span, div[role="banner"] span');
            if (el) { const t = await el.innerText().catch(() => ''); if (t && t.length < 50) userName = t.trim(); }
        } catch(e) {}
        
        await safeCloseContext(context);
        context = null;
        try { fs.rmSync(checkProfileDir, { recursive: true, force: true }); } catch(e) {}
        
        return res.json({ valid: true, user_id: userId, user_name: userName, cookie_count: parsedCookies.length });
    } catch (err) {
        if (context) await safeCloseContext(context);
        return res.json({ valid: false, error: `Check fail: ${err.message}` });
    }
});

// ================== START API ==================
app.post('/api/start', async (req, res) => {
    const { cookies, threadId, e2eePin, prefix, messages, delay } = req.body;
    
    for (const [id, t] of activeTasks.entries()) {
        if (t.isRunning) {
            t.isRunning = false;
            if (t.context) await safeCloseContext(t.context);
        }
    }
    
    const taskId = "TASK-" + Math.floor(100000 + Math.random() * 900000);
    const startedAt = Date.now();
    const originalData = { cookies, threadId, e2eePin, prefix, messages, delay, startedAt };
    
    const taskData = {
        taskId, isRunning: true, startedAt,
        logs: [`[${new Date().toLocaleTimeString()}] Task Initialized. ID: ${taskId}`],
        context: null, originalData
    };

    activeTasks.set(taskId, taskData);
    saveTasksToDisk();

    runPlaywrightBot(taskId, cookies, threadId, e2eePin, prefix, messages, delay)
        .catch(err => {
            console.log('[BOT CRASH]', err.message);
            const t = activeTasks.get(taskId);
            if (t) { t.isRunning = false; t.logs.push(`[FATAL] ${err.message}`); }
        });

    res.json({ success: true, taskId });
});

// ================== SESSION SETUP ==================
async function setupSession(taskId, cookiesStr, threadId, e2eePin, addLog, forceFresh = false) {
    const { context } = await launchPersistentBrowser(taskId, cookiesStr, addLog, forceFresh);
    
    context.on('close', () => {
        addLog(`⚠️ Context closed event`);
    });
    
    const page = await context.newPage();
    
    page.on('crash', () => {
        addLog(`💥 Page crashed!`);
    });
    page.on('close', () => {
        addLog(`⚠️ Page closed event`);
    });
    page.on('pageerror', (err) => {
        addLog(`⚠️ Page error: ${err.message}`);
    });

    addLog(`Navigating to Thread: ${threadId}`);
    await page.goto(`https://www.messenger.com/t/${threadId}`, { 
        waitUntil: 'domcontentloaded', timeout: 60000 
    });

    await page.waitForTimeout(3000);

    if (e2eePin) {
        try {
            const pinSelector = 'input[type="password"], input[aria-label*="PIN"], input[placeholder*="PIN"]';
            const pinInput = await page.waitForSelector(pinSelector, { timeout: 8000 }).catch(() => null);
            if (pinInput) {
                addLog(`E2EE PIN detected. Entering...`);
                await pinInput.click();
                await pinInput.fill(e2eePin);
                await page.keyboard.press('Enter');
                const submitBtn = await page.$('button[type="submit"], div[role="button"]:has-text("Continue"), div[role="button"]:has-text("Submit")').catch(() => null);
                if (submitBtn) await submitBtn.click();
                addLog(`PIN submitted. Waiting...`);
                await page.waitForTimeout(6000);
            }
        } catch (pErr) {
            addLog(`PIN Warning: ${pErr.message}`);
        }
    }

    const possibleSelectors = [
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][aria-label*="Message"]',
        'div[contenteditable="true"]',
        'div[aria-label="Message"]',
        'div[role="textbox"]'
    ];

    let inputSelector = null;
    addLog(`Searching for input box...`);
    for (const selector of possibleSelectors) {
        try {
            await page.waitForSelector(selector, { timeout: 6000 });
            inputSelector = selector;
            break;
        } catch (e) {}
    }

    if (!inputSelector) {
        await safeCloseContext(context);
        throw new Error(`Input box not found`);
    }

    return { context, page, inputSelector };
}

// ================== SEND MESSAGE WITH RETRY ==================
async function sendMessageWithRetry(page, inputSelector, finalPayload, addLog) {
    for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
        try {
            const sessionCheck = await isSessionAlive(page);
            if (!sessionCheck.alive) {
                return { success: false, reason: 'SESSION_DEAD', detail: sessionCheck.reason };
            }
            
            await page.evaluate(({ selector, text }) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('delete', false, null);
                    document.execCommand('insertText', false, text);
                }
            }, { selector: inputSelector, text: finalPayload });

            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1500);

            const stillThere = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.innerText.trim().length : -1;
            }, inputSelector).catch(() => -1);

            if (stillThere === -1) {
                return { success: false, reason: 'INPUT_GONE' };
            }
            
            if (stillThere === 0) {
                return { success: true };
            }
            
            addLog(`⚠️ Attempt ${attempt}: Input still has text, retrying...`);
            await page.waitForTimeout(2000);
        } catch (err) {
            addLog(`⚠️ Attempt ${attempt} error: ${err.message}`);
            if (attempt < NETWORK_RETRY_ATTEMPTS) await sleep(3);
        }
    }
    return { success: false, reason: 'MAX_RETRIES' };
}

// ================== AUTO RELOGIN ==================
async function attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog) {
    addLog(`🔄 Attempting auto-relogin with original cookies...`);
    
    for (let attempt = 1; attempt <= RELOGIN_MAX_RETRIES; attempt++) {
        try {
            addLog(`🔐 Relogin attempt ${attempt}/${RELOGIN_MAX_RETRIES}...`);
            killZombieChromium();
            await sleep(3);
            
            const session = await setupSession(taskId, cookiesStr, threadId, e2eePin, addLog, true);
            addLog(`✅ Relogin successful!`);
            return session;
        } catch (err) {
            addLog(`❌ Relogin attempt ${attempt} failed: ${err.message}`);
            if (attempt < RELOGIN_MAX_RETRIES) await sleep(10);
        }
    }
    
    return null;
}

// ================== MAIN BOT ==================
async function runPlaywrightBot(taskId, cookiesStr, threadId, e2eePin, prefix, messages, delay) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const addLog = (msg) => {
        if (!task.logs) task.logs = [];
        task.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (task.logs.length > 200) task.logs.shift();
    };

    let context = null;
    let page = null;
    let inputSelector = null;
    let lastRestart = Date.now();
    let lastSuccessfulSend = Date.now();
    let consecutiveFailures = 0;

    try {
        addLog(`Setting up session...`);
        const session = await setupSession(taskId, cookiesStr, threadId, e2eePin, addLog);
        context = session.context;
        page = session.page;
        inputSelector = session.inputSelector;
        task.context = context;

        addLog(`✅ Connected. Loop started.`);
        addLog(`⏰ 12h browser restart | 🛡️ Session check every ${SESSION_CHECK_EVERY} msg`);
        addLog(`💾 950 MB memory limit | 🐕 Watchdog: ${WATCHDOG_TIMEOUT/60000}min`);

        let index = 0;
        let msgCount = 0;

        while (task.isRunning) {
            
            // ========== 12 HOUR BROWSER RESTART ==========
            if (Date.now() - lastRestart >= BROWSER_RESTART_INTERVAL) {
                addLog(`🔄 12h complete. Browser restart...`);
                await safeCloseContext(context);
                context = null; page = null;
                killZombieChromium();
                await sleep(3);
                
                let success = false;
                for (let attempt = 1; attempt <= RESTART_MAX_RETRIES; attempt++) {
                    try {
                        const newSession = await setupSession(taskId, cookiesStr, threadId, e2eePin, addLog);
                        context = newSession.context;
                        page = newSession.page;
                        inputSelector = newSession.inputSelector;
                        task.context = context;
                        lastRestart = Date.now();
                        lastSuccessfulSend = Date.now();
                        addLog(`✅ Browser restarted.`);
                        success = true;
                        break;
                    } catch (rErr) {
                        addLog(`⚠️ Restart ${attempt} fail: ${rErr.message}`);
                        if (attempt < RESTART_MAX_RETRIES) { killZombieChromium(); await sleep(RESTART_RETRY_DELAY / 1000); }
                    }
                }
                if (!success) {
                    addLog(`❌ Restart fail. Trying relogin...`);
                    const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                    if (reloginSession) {
                        context = reloginSession.context;
                        page = reloginSession.page;
                        inputSelector = reloginSession.inputSelector;
                        task.context = context;
                        lastRestart = Date.now();
                        lastSuccessfulSend = Date.now();
                    } else {
                        addLog(`❌ Relogin fail. Task stop.`);
                        task.isRunning = false;
                        break;
                    }
                }
            }
            
            // ========== WATCHDOG ==========
            if (Date.now() - lastSuccessfulSend > WATCHDOG_TIMEOUT) {
                addLog(`🐕 Watchdog: ${WATCHDOG_TIMEOUT/60000}min no successful send. Force restart...`);
                await safeCloseContext(context);
                context = null; page = null;
                killZombieChromium();
                await sleep(3);
                
                const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                if (reloginSession) {
                    context = reloginSession.context;
                    page = reloginSession.page;
                    inputSelector = reloginSession.inputSelector;
                    task.context = context;
                    lastRestart = Date.now();
                    lastSuccessfulSend = Date.now();
                    consecutiveFailures = 0;
                } else {
                    addLog(`❌ Watchdog recovery fail. Stop.`);
                    task.isRunning = false;
                    break;
                }
            }
            
            // ========== HEALTH CHECK ==========
            if (!page || page.isClosed()) {
                addLog(`⚠️ Page closed. Attempting recovery...`);
                const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                if (reloginSession) {
                    context = reloginSession.context;
                    page = reloginSession.page;
                    inputSelector = reloginSession.inputSelector;
                    task.context = context;
                    lastRestart = Date.now();
                    lastSuccessfulSend = Date.now();
                    continue;
                } else {
                    addLog(`❌ Recovery fail. Stop.`);
                    break;
                }
            }

            // ========== SESSION CHECK ==========
            if (msgCount > 0 && msgCount % SESSION_CHECK_EVERY === 0) {
                const check = await isSessionAlive(page);
                if (!check.alive) {
                    addLog(`🚨 Session dead: ${check.reason}`);
                    addLog(`🔄 Auto-relogin try kar raha hoon...`);
                    
                    await safeCloseContext(context);
                    context = null; page = null;
                    
                    const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                    if (reloginSession) {
                        context = reloginSession.context;
                        page = reloginSession.page;
                        inputSelector = reloginSession.inputSelector;
                        task.context = context;
                        lastRestart = Date.now();
                        lastSuccessfulSend = Date.now();
                        consecutiveFailures = 0;
                        addLog(`✅ Session recovered!`);
                        continue;
                    } else {
                        addLog(`❌ Auto-relogin fail. Task stop. Fresh cookies lo.`);
                        task.isRunning = false;
                        break;
                    }
                }
            }

            const rawMsg = messages[index];
            const finalPayload = (prefix ? prefix + " " : "") + rawMsg;

            const result = await sendMessageWithRetry(page, inputSelector, finalPayload, addLog);
            
            if (result.success) {
                addLog(`✅ Sent: "${finalPayload.substring(0, 50)}"`);
                lastSuccessfulSend = Date.now();
                consecutiveFailures = 0;
            } else if (result.reason === 'SESSION_DEAD' || result.reason === 'INPUT_GONE') {
                addLog(`🚨 Session dead during send: ${result.detail || result.reason}`);
                addLog(`🔄 Auto-relogin...`);
                
                await safeCloseContext(context);
                context = null; page = null;
                
                const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                if (reloginSession) {
                    context = reloginSession.context;
                    page = reloginSession.page;
                    inputSelector = reloginSession.inputSelector;
                    task.context = context;
                    lastRestart = Date.now();
                    lastSuccessfulSend = Date.now();
                    continue;
                } else {
                    addLog(`❌ Relogin fail. Stop.`);
                    task.isRunning = false;
                    break;
                }
            } else {
                consecutiveFailures++;
                addLog(`⚠️ Send fail (${result.reason}). Failures: ${consecutiveFailures}/3`);
                
                if (consecutiveFailures >= 3) {
                    addLog(`🚨 3 consecutive failures. Force recovery...`);
                    consecutiveFailures = 0;
                    
                    await safeCloseContext(context);
                    context = null; page = null;
                    
                    const reloginSession = await attemptRelogin(taskId, cookiesStr, threadId, e2eePin, addLog);
                    if (reloginSession) {
                        context = reloginSession.context;
                        page = reloginSession.page;
                        inputSelector = reloginSession.inputSelector;
                        task.context = context;
                        lastRestart = Date.now();
                        lastSuccessfulSend = Date.now();
                        continue;
                    } else {
                        addLog(`❌ Recovery fail. Stop.`);
                        task.isRunning = false;
                        break;
                    }
                }
            }

            index = (index + 1) % messages.length;
            msgCount++;

            // ========== MEMORY CLEANUP ==========
            if (msgCount > 0 && msgCount % PAGE_RELOAD_EVERY === 0) {
                addLog(`🔄 Memory cleanup (msg #${msgCount})...`);
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(5000);
                    for (const selector of ['div[role="textbox"][contenteditable="true"]', 'div[contenteditable="true"]']) {
                        try { await page.waitForSelector(selector, { timeout: 6000 }); inputSelector = selector; break; } catch (e) {}
                    }
                    addLog(`✅ Memory cleaned.`);
                } catch (rErr) {
                    addLog(`⚠️ Cleanup fail: ${rErr.message}`);
                }
            }

            for (let i = 0; i < delay; i++) {
                if (!task.isRunning) break;
                await sleep(1);
            }
        }

        addLog(`Task Loop Terminated.`);

    } catch (err) {
        addLog(`FATAL ERROR: ${err.message}`);
    } finally {
        task.isRunning = false;
        await safeCloseContext(context);
    }
}

// ================== STATUS API ==================
app.get('/api/status/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ found: false });
    res.json({ found: true, taskId: task.taskId, isRunning: task.isRunning, startedAt: task.startedAt, logs: task.logs || [] });
});

app.get('/api/logs/:taskId', (req, res) => {
    const task = activeTasks.get(req.params.taskId);
    if (!task) return res.json({ logs: ["Task not found."] });
    res.json({ logs: task.logs });
});

// ================== STOP API ==================
app.post('/api/stop', async (req, res) => {
    const { taskId } = req.body;
    const task = activeTasks.get(taskId);
    if (!task) return res.json({ message: "Invalid Task ID!" });

    task.isRunning = false;
    task.originalData = null;
    if (task.context) await safeCloseContext(task.context);
    if (task.logs) task.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Stopped.`);
    
    try {
        const profileDir = path.join(DATA_DIR, `browser-profile-${taskId}`);
        if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    } catch(e) {}
    
    saveTasksToDisk();
    res.json({ message: `Task ${taskId} stopped!` });
});

// ================== HEALTH ==================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    let totalRamMB = Math.round(mem.rss / 1024 / 1024);
    try {
        if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
            const bytes = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
            totalRamMB = Math.round(bytes / 1024 / 1024);
        } else if (fs.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
            const bytes = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
            totalRamMB = Math.round(bytes / 1024 / 1024);
        }
    } catch(e) {}
    
    let tasksData = {};
    try { if (fs.existsSync(TASKS_FILE)) tasksData = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch(e) {}
    
    let profiles = [];
    try { profiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('browser-profile-')); } catch(e) {}
    
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()) + 's',
        node_ram_mb: Math.round(mem.rss / 1024 / 1024),
        total_ram_mb: totalRamMB,
        memory_limit_mb: MEMORY_LIMIT_MB,
        restart_interval_hours: BROWSER_RESTART_INTERVAL / 3600000,
        active_tasks: Array.from(activeTasks.keys()).filter(k => activeTasks.get(k).isRunning),
        saved_tasks: Object.keys(tasksData),
        browser_profiles: profiles,
        volume_mounted: fs.existsSync(DATA_DIR)
    });
});

// ================== MEMORY MONITOR ==================
setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    let totalMB = rssMB;
    try {
        if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
            const bytes = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
            totalMB = Math.round(bytes / 1024 / 1024);
        }
    } catch(e) {}
    
    console.log(`[MEMORY] Node: ${rssMB}MB | Total: ${totalMB}MB | Limit: ${MEMORY_LIMIT_MB}MB`);
    
    if (totalMB > MEMORY_LIMIT_MB) {
        console.log(`⚠️ Memory high (${totalMB}MB > ${MEMORY_LIMIT_MB}MB). Killing contexts...`);
        for (const [id, t] of activeTasks.entries()) {
            if (t.isRunning && t.context) {
                t.context.close().catch(() => {});
            }
        }
    }
}, 2 * 60 * 1000);

// ================== PERIODIC SAVE ==================
setInterval(() => {
    const runningCount = Array.from(activeTasks.values()).filter(t => t.isRunning).length;
    if (runningCount > 0) saveTasksToDisk();
}, 5 * 60 * 1000);

// ================== START SERVER ==================
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`📂 Volume: ${DATA_DIR}`);
    console.log(`⏰ Restart every ${BROWSER_RESTART_INTERVAL/3600000}h | 💾 Memory limit: ${MEMORY_LIMIT_MB}MB`);
    await loadTasksFromDisk();
});
