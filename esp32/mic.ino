#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// --- DONANIM PİN TANIMLARI ---
#define MOISTURE_PIN 34   // Analog: Toprak Nem Sensörü
#define RAIN_PIN     35   // Dijital: Yağmur Sensörü
#define RELAY_PIN    26   // Dijital: Pompa Rölesi (Low-Level Trigger)
#define BATTERY_PIN  32   // Analog: Batarya Voltajı

// --- SİSTEM & AĞ AYARLARI ---
const char* ssid = "WIFI_ADINIZ"; 
const char* password = "WIFI_SIFRENIZ"; 
const char* backendUrl = "http://BACKEND_IP_ADRESI:3001/api/sensors/data"; 

// --- HAVA DURUMU API AYARLARI (YENİ EKLENDİ) ---
const char* openWeatherApiKey = "SENIN_OPENWEATHER_API_ANAHTARIN"; 
const char* city = "Ankara,TR"; // Kendi şehrine göre değiştirebilirsin

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(115200);

  // Pin Modları
  pinMode(MOISTURE_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT_PULLUP);
  pinMode(BATTERY_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);

  // Röle Low-Level Trigger olduğu için HIGH komutu pompaya giden elektriği KESER.
  digitalWrite(RELAY_PIN, HIGH);

  // Ekranı Başlat
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Sistem Basliyor");

  // WiFi Bağlantısı
  WiFi.begin(ssid, password);
  Serial.print("WiFi Baglaniyor...");
}

void loop() {
  // 1. SENSÖR VERİLERİNİ TOPLA
  float moisture = readMoisture();
  bool isRaining = (digitalRead(RAIN_PIN) == LOW); // LOW = Yağmur algılandı
  float batteryV = readBattery();
  float batteryPct = constrain((batteryV - 3.0) / (4.2 - 3.0) * 100.0, 0, 100);

  // 2. LCD EKRANI GÜNCELLE
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Nem: %" + String((int)moisture));
  lcd.setCursor(10, 0);
  lcd.print(isRaining ? "YAGMUR" : "KURU");

  // 3. KARAR MEKANİZMASI
  if (WiFi.status() == WL_CONNECTED) {
    // ONLINE MOD: Backend'e verileri gönder
    processOnlineMode(moisture, isRaining, batteryV, batteryPct);
  } else {
    // OFFLINE MOD: İnternet yoksa kendi başına karar ver
    processOfflineMode(moisture, isRaining);
  }

  // 1 dakika bekle ve tekrarla
  delay(60000);
}

// --- YENİ EKLENEN HAVA DURUMU SORGULAMA FONKSİYONU ---
int fetchRainProbability() {
  if(WiFi.status() != WL_CONNECTED) return 0;
  
  HTTPClient http;
  String url = "http://api.openweathermap.org/data/2.5/forecast?q=" + String(city) + "&cnt=1&appid=" + String(openWeatherApiKey);
  
  http.begin(url);
  int httpCode = http.GET();
  int prob = 0;
  
  if (httpCode == 200) {
    String payload = http.getString();
    DynamicJsonDocument doc(2048); 
    deserializeJson(doc, payload);
    
    // pop (Probability of precipitation): Yağış olasılığı (0.00 - 1.00 arası gelir)
    float pop = doc["list"][0]["pop"]; 
    prob = (int)(pop * 100); 
    Serial.println("Yagmur Ihtimali: %" + String(prob));
  } else {
    Serial.println("Hava durumu API hatasi!");
  }
  
  http.end();
  return prob;
}

// --- KARAR MOTORLARI ---

void processOnlineMode(float m, bool r, float bv, float bp) {
  HTTPClient http;
  http.begin(backendUrl);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<512> doc;
  doc["moisture"] = m;
  doc["temperature"] = 24.0; 
  doc["humidity"] = 50.0;
  
  // YENİ: Artık 0 yerine API'den gelen gerçek veriyi gönderiyoruz
  doc["rain_probability"] = fetchRainProbability(); 
  
  doc["is_raining"] = r;
  doc["battery_voltage"] = bv;
  doc["battery_level"] = bp;

  String requestBody;
  serializeJson(doc, requestBody);
  
  int httpCode = http.POST(requestBody);
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> resDoc;
    deserializeJson(resDoc, response);

    String action = resDoc["action"];
    int duration = resDoc["duration"];

    // Backend "SULA" derse pompayı çalıştır
    if (action == "IRRIGATE") {
      runPump(duration);
    }
  }
  http.end();
}

void processOfflineMode(float m, bool r) {
  // İnternet yoksa ve fiziksel yağmur varsa sulama yapma
  if (r) return;

  // İnternet yoksa nem %30'un altına düştüğünde acil durum sulaması yap (10 sn)
  if (m < 30.0) {
    runPump(10); 
  }
}

// --- YARDIMCI FONKSİYONLAR ---

void runPump(int seconds) {
  seconds = constrain(seconds, 0, 30); // Max 30 sn güvenlik kilidi
  lcd.setCursor(0, 1);
  lcd.print("POMPA AKTIF!    "); 
  
  // Röleyi AÇ (LOW)
  digitalWrite(RELAY_PIN, LOW); 
  delay(seconds * 1000);
  
  // Röleyi KAPAT (HIGH)
  digitalWrite(RELAY_PIN, HIGH); 
  
  lcd.setCursor(0, 1);
  lcd.print("                "); 
}

float readMoisture() {
  int raw = analogRead(MOISTURE_PIN);
  float pct = map(raw, 4095, 1000, 0, 100);
  return constrain(pct, 0, 100);
}

float readBattery() {
  int raw = analogRead(BATTERY_PIN);
  return (raw / 4095.0) * 3.3 * 2.0;
}