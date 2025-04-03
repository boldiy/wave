const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

// 配置信息
const config = {
    SecretId: process.env.TENCENT_SECRET_ID,
    SecretKey: process.env.TENCENT_SECRET_KEY,
    host: 'asr.tencentcloudapi.com',
    path: '/',
    service: 'asr',
    region: 'ap-guangzhou',
    action: 'SentenceRecognition',
    version: '2019-06-14',
    algorithm: 'TC3-HMAC-SHA256'
};

// 生成签名
function generateSignature(timestamp, date, payload) {
    const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + config.host + '\n';
    const signedHeaders = 'content-type;host';
    const hashedRequestPayload = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalRequest = 'POST\n' + config.path + '\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedRequestPayload;

    const credentialScope = date + '/' + config.service + '/tc3_request';
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = config.algorithm + '\n' + timestamp + '\n' + credentialScope + '\n' + hashedCanonicalRequest;

    const secretDate = crypto.createHmac('sha256', 'TC3' + config.SecretKey).update(date).digest();
    const secretService = crypto.createHmac('sha256', secretDate).update(config.service).digest();
    const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
    return crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
}

// 语音识别函数
function recognizeAudio(filePath) {
    return new Promise((resolve, reject) => {
        try {
            const timestamp = Math.floor(Date.now() / 1000);
            const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

            // 读取音频文件
            const audioFile = fs.readFileSync(filePath);
            const audioBase64 = audioFile.toString('base64');

            // 构建请求参数
            const params = {
                ProjectId: 0,
                SubServiceType: 2,
                EngSerViceType: '16k_zh',
                SourceType: 1,
                VoiceFormat: 'pcm',
                UsrAudioKey: 'test_audio',
                Data: audioBase64,
                DataLen: audioBase64.length
            };

            const payload = JSON.stringify(params);
            const signature = generateSignature(timestamp, date, payload);
            const credentialScope = date + '/' + config.service + '/tc3_request';
            const authorization = config.algorithm + ' ' + 'Credential=' + config.SecretId + '/' + credentialScope + ', ' + 'SignedHeaders=content-type;host, ' + 'Signature=' + signature;

            // 构建请求选项
            const options = {
                hostname: config.host,
                path: config.path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Host': config.host,
                    'X-TC-Action': config.action,
                    'X-TC-Version': config.version,
                    'X-TC-Timestamp': timestamp,
                    'X-TC-Region': config.region,
                    'Authorization': authorization
                }
            };

            // 发送请求
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    const result = JSON.parse(data);
                    if (result.Response && result.Response.Result) {
                        resolve(result.Response.Result);
                    } else {
                        reject(new Error('识别失败：' + JSON.stringify(result)));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.write(payload);
            req.end();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = {
    recognizeAudio
};