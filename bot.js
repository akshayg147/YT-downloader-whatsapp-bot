require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const AWS = require('aws-sdk');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = new twilio(accountSid, authToken);


const sts = new AWS.STS({ region: process.env.AWS_REGION });


const bucketName = process.env.bName;


const assumeRoleParams = {
  RoleArn: process.env.role_arn,
  RoleSessionName: 'YoututbeDownload'
};


const youtubeUrlRegex = /^(https?\:\/\/)?(www\.youtube\.com|youtu\.?be)\/.+$/;


const userState = {};


app.post('/webhook', async (req, res) => {
    const from = req.body.From;
    const body = req.body.Body.trim();


    if (userState[from] && userState[from].pendingFormat) {
        if (body.toLowerCase() === 'mp3' || body.toLowerCase() === 'mp4') {
            userState[from].format = body.toLowerCase();
            userState[from].pendingFormat = false;

            const url = userState[from].url;
            sendWhatsAppMessage(from, 'Link received successfully! Please wait while we are working on the link.\n Please note the waiting time depends on the length the video. :)');
            await processYouTubeLink(from, url, userState[from].format);

            delete userState[from]; 
        } else {
            await sendWhatsAppMessage(from, 'Invalid input. Please select either "mp3" or "mp4".');
        }
    } else if (isValidYouTubeUrl(body)) {
        userState[from] = { url: body, pendingFormat: true };
        await sendWhatsAppMessage(from, 'Please select the format in which you want to download youtube video: "mp3" or "mp4".');
    } else {
        await sendWhatsAppMessage(from, 'Invalid YouTube URL. Please send a valid URL.');
    }

    res.sendStatus(200);
});

const isValidYouTubeUrl = (url) => {
    return youtubeUrlRegex.test(url);
};

  
const processYouTubeLink = async (from, url, format) => {
    try {

        const metadata = await getYouTubeMetadata(url);
        const title = metadata.title.replace(/[^\w\s]/gi, '');
        var outputPath = await downloadYouTubeVideo(url,title);
        const mp4video = outputPath

        if (format=="mp3"){
            mp3outputPath = path.join(__dirname, `${title}.mp3`);
            outputPath = await convertToMp3(outputPath, mp3outputPath);
        }
        else{
            outputPath = path.join(__dirname, `${title}.mp4`);
        }

        const tempCredentials = await assumeRole();


        const s3 = new AWS.S3({
            accessKeyId: tempCredentials.AccessKeyId,
            secretAccessKey: tempCredentials.SecretAccessKey,
            sessionToken: tempCredentials.SessionToken
        });


        const s3Key = path.basename(outputPath);
        await uploadToS3(s3, outputPath, s3Key);


        const presignedUrl = generatePresignedUrl(s3, s3Key);
        // const shortenedUrl = await shortenUrl(presignedUrl);

        await sendWhatsAppMessage(from, presignedUrl);


        fs.unlinkSync(outputPath);
        if (format=="mp3"){
            fs.unlinkSync(mp4video);
        }
    } catch (error) {
        console.error('Error handling message:', error);
        await sendWhatsAppMessage(from, 'An error occurred while processing your request.');
    }
};

const downloadYouTubeVideo = (url,title) => {
    return new Promise((resolve, reject) => {
        const output = path.join(__dirname, `${title}.mp4`);
        youtubedl(url, { output })
            .then(() => resolve(output))
            .catch((err) => reject(err));
    });
};

const convertToMp3 = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.setFfmpegPath(ffmpegPath);
        ffmpeg(inputPath)
            .toFormat('mp3')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
};

const getYouTubeMetadata = (url) => {
    return youtubedl(url, {
        dumpSingleJson: true
    });
};

const uploadToS3 = (s3, filePath, key) => {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const params = {
            Bucket: bucketName,
            Key: key,
            Body: fileStream
        };
        s3.upload(params, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
};

const generatePresignedUrl = (s3, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
        Expires: 1800
    };
    return s3.getSignedUrl('getObject', params);
};

const sendWhatsAppMessage = (to, body) => {
    return client.messages.create({
        body: body,
        from: process.env.whatsapp_number,
        to: to
    });
};
const assumeRole = () => {
    return new Promise((resolve, reject) => {
        sts.assumeRole(assumeRoleParams, (err, data) => {
            if (err) {
                console.error('Error assuming role:', err);
                reject(err);
            } else {
                resolve(data.Credentials);
            }
        });
    });
};

const shortenUrl = async (longUrl) => {
    try {
        const apiKey = process.env.BITLY_API_KEY;
        const bitlyUrl = 'https://api-ssl.bitly.com/v4/shorten';
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };

        const response = await axios.post(bitlyUrl, {
            long_url: longUrl
        }, { headers });

        return response.data.link;
    } catch (error) {
        console.error('Error shortening URL:', error.response.data);
        throw error;
    }
};

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});