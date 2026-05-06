import express from 'express';
import cors from 'cors';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Dashboard için en güncel veriyi getir
app.get('/api/sensors/latest', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sensor_logs ORDER BY recorded_at DESC LIMIT 1');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ESP32'den Veri Alma Rotası (YAPAY ZEKA KARAR MEKANİZMASI) ---
app.post('/api/sensors/data', async (req, res) => {
    const { moisture, temperature, humidity, rain_probability, is_raining, battery_voltage, battery_level } = req.body;

    try {
        const now = new Date();
        
        // 1. Gelen veriyi veritabanına kaydet
        await pool.query(
            `INSERT INTO sensor_logs 
            (soil_moisture, temperature, humidity, rain_probability, is_raining, battery_voltage, battery_level, wifi_connected, recorded_at) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [moisture, temperature, humidity, rain_probability, is_raining, battery_voltage, battery_level, true, now]
        );

        // 2. Ayarları Çek
        const settingsRes = await pool.query("SELECT moisture_threshold_low, rain_probability_threshold FROM system_settings WHERE id=1");
        const moistureThreshold = settingsRes.rows[0]?.moisture_threshold_low || 35;
        const rainProbThreshold = settingsRes.rows[0]?.rain_probability_threshold || 50; 

        let action = "SKIP";
        let duration = 0;

        // --- YENİ EKLENEN KARAR MANTIĞI ---
        
        // DURUM 1: Nem düşük, yağmur yağmıyor VE yağmur BEKLENMİYORSA -> SULA
        if (moisture < moistureThreshold && !is_raining && rain_probability < rainProbThreshold) {
            action = "IRRIGATE";
            duration = 15; // 15 saniye (ESP32 tarafında saniye olarak işlenir)
            
            await pool.query(
                `INSERT INTO irrigation_history (start_time, duration_minutes, trigger_type, moisture_before, moisture_after, liters_consumed) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [now, duration, 'Automatic', moisture, moisture + 20, 12.5]
            );
            await pool.query(
                `INSERT INTO notifications (type, title, message, read, timestamp) 
                 VALUES ('info', 'Otomatik Sulama', 'Nem %' || $1 || ' olduğu için sistem devreye girdi.', false, $2)`,
                [Math.round(moisture), now]
            );
        } 
        // DURUM 2: Nem düşük, yağmur yağmıyor AMA YAĞMUR BEKLENİYORSA -> SULAMAYI ERTELE
        else if (moisture < moistureThreshold && !is_raining && rain_probability >= rainProbThreshold) {
            console.log(`🌧️ Beklenen Yağmur Olasılığı (%${rain_probability}) yüksek. Sulama ERTELENDİ.`);
            
            // Eğer o saat içinde erteleme bildirimi atmamışsak atalım (Spam olmaması için opsiyonel yapılabilir)
            await pool.query(
                `INSERT INTO notifications (type, title, message, read, timestamp) 
                 VALUES ('warning', 'Sulama Ertelendi', 'Nem düşük ancak yaklaşan yağmur tahmini (%' || $1 || ') nedeniyle sulama tasarruf amaçlı yapılmadı.', false, $2)`,
                [rain_probability, now]
            );
        }

        // ESP32'ye verilecek emiri dön (SULA veya PAS GEÇ)
        res.json({ success: true, action: action, duration: duration });

    } catch (err) {
        console.error("❌ ESP32 Veri Alma Hatası:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM irrigation_history ORDER BY start_time DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/notifications', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notifications ORDER BY timestamp DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET read = true WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/read-all', async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET read = true WHERE read = false');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pump/control', async (req, res) => {
    const { action, moistureBefore, duration } = req.body;

    try {
        if (action === 'ON') {
            await pool.query(
                "INSERT INTO notifications (type, title, message, read, timestamp) VALUES ($1, $2, $3, $4, $5)",
                ['info', 'Manuel Sulama', 'Kullanıcı pompayı manuel olarak başlattı.', false, new Date()]
            );
            console.log("💧 Pompa AÇILDI bildirimi eklendi.");
        } else if (action === 'OFF') {
            const mb = parseFloat(moistureBefore) || 50;
            const finalDuration = parseFloat(duration) || 1.0;
            const moistureAfter = mb + 5;
            const currentTime = new Date();

            await pool.query(
                `INSERT INTO irrigation_history (start_time, duration_minutes, trigger_type, moisture_before, moisture_after, liters_consumed) 
                 VALUES ($1, $2, $3, $4, $5, $6)`, 
                [currentTime, finalDuration, 'Manual', mb, moistureAfter, 4.5] 
            );
            console.log(`✅ Geçmişe kayıt eklendi: ${finalDuration} dk, Nem: %${mb}`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Pompa kontrol hatası:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports', async (req, res) => {
    const { period } = req.query; 
    let query = "";

    try {
        if (period === 'Weekly') {
            query = `SELECT to_char(date_trunc('week', start_time), 'Mon DD') || ' - ' || to_char(date_trunc('week', start_time) + interval '6 days', 'Mon DD') as date, SUM(liters_consumed) as liters, SUM(duration_minutes) as duration FROM irrigation_history WHERE start_time > NOW() - interval '12 weeks' GROUP BY date_trunc('week', start_time) ORDER BY date_trunc('week', start_time) ASC;`;
        } else if (period === 'Monthly') {
            query = `SELECT to_char(start_time, 'Mon YYYY') as date, SUM(liters_consumed) as liters, SUM(duration_minutes) as duration FROM irrigation_history WHERE start_time > NOW() - interval '6 months' GROUP BY date_trunc('month', start_time), date ORDER BY date_trunc('month', start_time) ASC;`;
        } else {
            query = `SELECT to_char(start_time, 'Mon DD') as date, SUM(liters_consumed) as liters, SUM(duration_minutes) as duration FROM irrigation_history WHERE start_time > NOW() - interval '30 days' GROUP BY date_trunc('day', start_time), date ORDER BY date_trunc('day', start_time) ASC;`;
        }

        const result = await pool.query(query);
        const rows = result.rows.map(r => ({
            date: r.date,
            liters: Math.round(parseFloat(r.liters || 0)),
            duration: Math.round(parseFloat(r.duration || 0)),
            rainSkips: 0 
        }));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM system_settings WHERE id = 1');
        if (result.rows.length === 0) {
            return res.json({ moisture_threshold_low: 35, moisture_threshold_high: 80, rain_probability_threshold: 50, push_notifications: true });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', async (req, res) => {
    const {
        moistureThresholdLow, moistureThresholdHigh, rainProbabilityThreshold,
        pushNotifications, emailNotifications, deepSleepInterval, maxPumpRuntime
    } = req.body;

    try {
        await pool.query(
            `UPDATE system_settings 
             SET moisture_threshold_low = $1, moisture_threshold_high = $2, 
                 rain_probability_threshold = $3, push_notifications = $4,
                 email_notifications = $5, deep_sleep_interval = $6, 
                 max_pump_runtime = $7, updated_at = NOW() 
             WHERE id = 1`,
            [moistureThresholdLow, moistureThresholdHigh, rainProbabilityThreshold,
                pushNotifications, emailNotifications, deepSleepInterval, maxPumpRuntime]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Kaydetme hatası:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length > 0 && result.rows[0].password_hash === password) {
            res.json({ success: true, user: { id: result.rows[0].id, name: result.rows[0].full_name, role: result.rows[0].role } });
        } else {
            res.status(401).json({ success: false, message: 'Hatalı kullanıcı adı veya şifre' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend ${PORT} portunda canlı!`));