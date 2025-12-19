const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(require('cors')());

const PORT = process.env.PORT || 3001;
const PRIMARY_URL = process.env.PRIMARY_URL || 'http://localhost:3000';
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ FATAL: MONGO_URI environment variable is not set');
    process.exit(1);
}

const ServiceStatusSchema = new mongoose.Schema({
    service: String,
    status: String,
    lastPing: Date,
    responseTime: Number,
    error: String,
    timestamp: { type: Date, default: Date.now, index: true }
});

const EmergencyLogSchema = new mongoose.Schema({
    type: String,
    message: String,
    data: Object,
    timestamp: { type: Date, default: Date.now, index: true }
});

const ServiceStatus = mongoose.model('ServiceStatus', ServiceStatusSchema);
const EmergencyLog = mongoose.model('EmergencyLog', EmergencyLogSchema);

let primaryServiceDown = false;
let retryCount = 0;
const MAX_RETRIES = 10;

async function checkPrimaryService() {
    try {
        const startTime = Date.now();
        const response = await fetch(`${PRIMARY_URL}/api/health`, { timeout: 10000 });
        const responseTime = Date.now() - startTime;
        
        if (response.ok) {
            await ServiceStatus.create({
                service: 'primary',
                status: 'healthy',
                lastPing: new Date(),
                responseTime
            });
            
            if (primaryServiceDown) {
                console.log('✅ Primary service restored!');
                primaryServiceDown = false;
                retryCount = 0;
                await EmergencyLog.create({
                    type: 'service_recovery',
                    message: 'Primary service has recovered',
                    data: { responseTime }
                });
            }
            return true;
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        retryCount++;
        
        if (!primaryServiceDown) {
            console.log(`⚠️ Primary service down: ${error.message}`);
            primaryServiceDown = true;
        }
        return false;
    }
}

async function attemptServiceRecovery() {
    try {
        console.log(`🔄 Attempting to wake primary service (attempt ${retryCount})...`);
        await fetch(`${PRIMARY_URL}/`, { timeout: 5000 }).catch(() => {});
        await fetch(`${PRIMARY_URL}/api/health`, { timeout: 5000 }).catch(() => {});
    } catch (error) {
        console.log(`❌ Recovery attempt failed: ${error.message}`);
    }
}

app.get('/api/health', async (req, res) => {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const primaryHealthy = await checkPrimaryService();
    
    res.json({
        status: 'healthy',
        service: 'monitoring',
        timestamp: new Date().toISOString(),
        mongodb: mongoStatus,
        primaryService: {
            url: PRIMARY_URL,
            status: primaryHealthy ? 'healthy' : 'down',
            lastChecked: new Date().toISOString()
        },
        uptime: process.uptime()
    });
});

app.post('/api/ping', async (req, res) => {
    const { service, timestamp, status } = req.body;
    console.log(`📡 Ping received from ${service} at ${timestamp}`);
    res.json({ 
        received: true, 
        timestamp: new Date().toISOString(),
        message: 'Ping acknowledged' 
    });
});

app.get('/api/status/history', async (req, res) => {
    try {
        const history = await ServiceStatus.find().sort({ timestamp: -1 }).limit(100);
        const emergencies = await EmergencyLog.find().sort({ timestamp: -1 }).limit(50);
        res.json({ history, emergencies });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch status history' });
    }
});

app.post('/api/emergency/alert', async (req, res) => {
    try {
        const { type, message, data } = req.body;
        await EmergencyLog.create({ type, message, data, timestamp: new Date() });
        console.log(`🚨 Emergency logged: ${type} - ${message}`);
        res.json({ success: true, logged: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to log emergency' });
    }
});

app.post('/api/backup/login', async (req, res) => {
    const { location } = req.body;
    if (!location) {
        return res.status(403).json({
            error: 'EMERGENCY MODE: Location permission REQUIRED',
            emergency: true,
            backupMode: true
        });
    }
    res.json({
        success: true,
        message: 'Backup service active - Limited functionality',
        backupMode: true,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/backup/status', async (req, res) => {
    const primaryStatus = await ServiceStatus.findOne({ service: 'primary' }).sort({ timestamp: -1 });
    res.json({
        service: 'monitoring_backup',
        primaryStatus: primaryStatus || { status: 'unknown' },
        backupActive: true,
        timestamp: new Date().toISOString(),
        message: primaryServiceDown ? '⚠️ Primary service is down. Backup mode active.' : '✅ All services operational.'
    });
});

async function keepPrimaryAlive() {
    if (primaryServiceDown) {
        console.log('🔄 Attempting to revive primary service...');
        const endpoints = ['/', '/api/health', '/login', '/home'];
        for (const endpoint of endpoints) {
            try {
                await fetch(`${PRIMARY_URL}${endpoint}`, { method: 'HEAD', timeout: 3000 });
                console.log(`✅ ${endpoint} - Request sent`);
            } catch (error) {
                console.log(`❌ ${endpoint} - Failed: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000
}).then(() => {
    console.log('✅ Monitoring MongoDB Connected');
    
    app.listen(PORT, () => {
        console.log(`✅ Monitoring server running on port ${PORT}`);
        console.log(`🔗 Monitoring primary: ${PRIMARY_URL}`);
        
        EmergencyLog.create({
            type: 'startup',
            message: 'Monitoring service started',
            data: { port: PORT, primaryUrl: PRIMARY_URL }
        }).catch(err => console.log('Note: Initial log not critical:', err.message));
        
        checkPrimaryService();
        setInterval(checkPrimaryService, 30000);
        setInterval(keepPrimaryAlive, 120000);
    });
}).catch(err => {
    console.error('❌ Monitoring MongoDB Connection Failed:', err.message);
    console.error('Check your MONGO_URI and Atlas network settings.');
    process.exit(1);
});
