const express = require('express');
const multer = require('multer');
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const tencent = require('./tencent');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

// 添加CORS中间件
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// 讯飞配置
const config = {
    hostUrl: "wss://iat-api.xfyun.cn/v2/iat",
    host: "iat-api.xfyun.cn",
    appid: process.env.XUNFEI_APP_ID,
    apiSecret: process.env.XUNFEI_API_SECRET,
    apiKey: process.env.XUNFEI_API_KEY,
    uri: "/v2/iat"
};

// 帧定义
const FRAME = {
    STATUS_FIRST_FRAME: 0,
    STATUS_CONTINUE_FRAME: 1,
    STATUS_LAST_FRAME: 2
};

// 提供静态文件服务
app.use(express.static(path.join(__dirname)));

// 处理语音识别请求
app.post('/recognize', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error('没有收到音频文件');
        }

        const result = await recognizeAudio(req.file.path);
        res.json({ text: result });
    } catch (error) {
        console.error('识别错误:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // 清理临时文件
        // if (req.file && req.file.path) {
        //     fs.unlinkSync(req.file.path);
        // }
    }
});

// 处理腾讯语音识别请求
app.post('/recognize-tencent', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error('没有收到音频文件');
        }

        const result = await tencent.recognizeAudio(req.file.path);
        res.json({ text: result });
    } catch (error) {
        console.error('腾讯语音识别错误:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // 清理临时文件
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }
    }
});

// 语音识别函数
function recognizeAudio(filePath) {
    return new Promise((resolve, reject) => {
        let status = FRAME.STATUS_FIRST_FRAME;
        let currentSid = "";
        let iatResult = [];
        let finalResult = "";

        // 获取当前时间
        const date = new Date().toUTCString();

        // 构建WebSocket URL
        const wssUrl = config.hostUrl + "?authorization=" + getAuthStr(date) + "&date=" + date + "&host=" + config.host;
        const ws = new WebSocket(wssUrl);

        ws.on('open', () => {
            console.log("WebSocket连接已建立");

            // 读取音频文件
            const readerStream = fs.createReadStream(filePath, {
                highWaterMark: 1280
            });

            readerStream.on('data', (chunk) => {
                send(chunk, status);
            });

            readerStream.on('end', () => {
                status = FRAME.STATUS_LAST_FRAME;
                send("", status);
            });
        });

        ws.on('message', (data) => {
            const res = JSON.parse(data);

            if (res.code !== 0) {
                console.error(`错误码 ${res.code}, 原因 ${res.message}`);
                reject(new Error(res.message));
                return;
            }

            if (res.data.status === 2) {
                currentSid = res.sid;
                ws.close();
            }

            iatResult[res.data.result.sn] = res.data.result;

            if (res.data.result.pgs === 'rpl') {
                res.data.result.rg.forEach(i => {
                    iatResult[i] = null;
                });
            }

            let str = "";
            iatResult.forEach(i => {
                if (i != null) {
                    i.ws.forEach(j => {
                        j.cw.forEach(k => {
                            str += k.w;
                        });
                    });
                }
            });

            finalResult = str;
        });

        ws.on('close', () => {
            console.log(`本次识别sid：${currentSid}`);
            console.log('连接已关闭');
            resolve(finalResult);
        });

        ws.on('error', (err) => {
            console.error("WebSocket错误:", err);
            reject(err);
        });

        // 发送数据函数
        function send(data, status) {
            let frame = "";
            const frameDataSection = {
                "status": status,
                "format": "audio/L16;rate=16000",
                "audio": data.toString('base64'),
                "encoding": "raw"
            };

            switch (status) {
                case FRAME.STATUS_FIRST_FRAME:
                    frame = {
                        common: {
                            app_id: config.appid
                        },
                        business: {
                            language: "zh_cn",
                            domain: "iat",
                            accent: "mandarin",
                            dwa: "wpgs"
                        },
                        data: frameDataSection
                    };
                    break;
                case FRAME.STATUS_CONTINUE_FRAME:
                case FRAME.STATUS_LAST_FRAME:
                    frame = {
                        data: frameDataSection
                    };
                    break;
            }

            ws.send(JSON.stringify(frame));
        }
    });
}

// 鉴权签名
function getAuthStr(date) {
    const signatureOrigin = `host: ${config.host}\ndate: ${date}\nGET ${config.uri} HTTP/1.1`;
    const signatureSha = CryptoJS.HmacSHA256(signatureOrigin, config.apiSecret);
    const signature = CryptoJS.enc.Base64.stringify(signatureSha);
    const authorizationOrigin = `api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(authorizationOrigin));
}

// 创建自签名证书
function createSelfSignedCert() {
    const { execSync } = require('child_process');
    const path = require('path');

    const sslDir = path.join(__dirname, 'ssl');
    const keyPath = path.join(sslDir, 'private.key');
    const certPath = path.join(sslDir, 'certificate.crt');

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.log('正在生成自签名证书...');
        execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`);
    }

    return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
}

// 启动HTTPS服务器
const PORT = process.env.PORT || 3000;
const sslOptions = createSelfSignedCert();
const server = https.createServer(sslOptions, app);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTPS服务器运行在 https://localhost:${PORT}`);
    console.log('注意：由于使用自签名证书，浏览器可能会显示安全警告，这是正常的。');
    console.log('在开发环境中，您可以点击"继续访问"来使用该服务。');
}); 
