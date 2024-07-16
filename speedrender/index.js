const AWS = require('aws-sdk');
const axios = require('axios');
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();

const cleanBase64String = (base64String) => {
    if (typeof base64String !== 'string') {
        return '';
    }
    return base64String.replace(/\s/g, '').replace(/^data:image\/\w+;base64,/, '');
};

const checkRunPodStatus = async (taskId, runpodToken) => {
    try {
        const statusUrl = `${process.env.RUNPOD_API_URL}/status/${taskId}`;
        const response = await axios.get(statusUrl, {
            headers: {
                'Authorization': `Bearer ${runpodToken}`
            }
        });
        return response.data;
    } catch (error) {
        throw new Error(`Erro ao verificar o status da tarefa no RunPod: ${error.message}`);
    }
};

exports.handler = async (event) => {
    try {
        let data;
        if (typeof event.body === 'string') {
            data = JSON.parse(event.body);
        } else {
            throw new Error('Corpo da solicitação não é uma string JSON válida');
        }

        const {
            base64, environment, projectName, text, user,
            architecturalStyle, weather, additionalOptions, hours, neg,
            seed, sampler_name, cfg_scale, steps,
            width, height, model
        } = data;

        if (!base64 || !environment || !projectName || !text || !user) {
            throw new Error('Faltam campos obrigatórios no JSON');
        }

        const cleanedImageBase64 = cleanBase64String(base64);
        if (!cleanedImageBase64) {
            throw new Error('Base64 inválido');
        }
        const imageBuffer = Buffer.from(cleanedImageBase64, 'base64');

        const s3ParamsAntes = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `antes_${projectName}.jpg`,
            Body: imageBuffer,
            ContentType: 'image/jpeg'
        };
        await s3.putObject(s3ParamsAntes).promise();
        const imageUrlAntes = `${process.env.S3_BUCKET_URL}/${s3ParamsAntes.Key}`;

        const runpodStartUrl = `${process.env.RUNPOD_API_URL}/run`;
        const runpodToken = process.env.RUNPOD_TOKEN;
        const task_uid = `task_${projectName}_${Date.now()}`;

        const runpodPayload = {
            input: {
                endpoint: "img2img",
                model: model || "model_indoor.safetensors",
                init_images: [cleanedImageBase64],
                prompt: process.env.PROMPT,
                negative_prompt: process.env.NEG_PROMPT,
                seed: process.env.SEED,
                sampler_name: sampler_name || "DPM adaptive",
                schedule_type: sampler_name || "Karras",
                steps: process.env.STEPS,
                cfg_scale: process.env.CFG_SCALE,
                width: width || 1280,
                height: height || 720,
                denoising_strength: process.env.DENOISING_STRENGTH,
                clip_skip: 10,
                image_cfg_scale: process.env.IMAGE_CFG_SCALE,
                controlnet_units: [
                    {
                        enabled: true,
                        control_type: "all",
                        control_weight: 1,
                        start_step: 0,
                        end_step: 1,
                        control_mode: "balanced"
                    }
                ], 
                refiner_switch_at: 10,
                resize: "auto"
            }
        };

        const runpodResponse = await axios.post(runpodStartUrl, runpodPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${runpodToken}`
            }
        });

        if (runpodResponse.status !== 200 || !runpodResponse.data.id) {
            throw new Error(`Falha ao iniciar a tarefa no RunPod: ${runpodResponse.statusText}`);
        }

        const taskId = runpodResponse.data.id;
        let taskStatus = runpodResponse.data.status;
        let retryCount = 0;
        const maxRetries = 20;
        while ((taskStatus === 'IN_QUEUE' || taskStatus === 'IN_PROGRESS') && retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const statusResponse = await checkRunPodStatus(taskId, runpodToken);
            taskStatus = statusResponse.status;
            retryCount++;
        }

        if (taskStatus !== 'COMPLETED') {
            throw new Error(`Tarefa ${taskId} falhou no RunPod com status: ${taskStatus}`);
        }

        const resultResponse = await checkRunPodStatus(taskId, runpodToken);
        if (!resultResponse.output || !resultResponse.output.images || resultResponse.output.images.length === 0) {
            throw new Error('A resposta do RunPod não contém a imagem processada esperada');
        }

        const processedImageBase64 = resultResponse.output.images[0];
        const processedImageBuffer = Buffer.from(cleanBase64String(processedImageBase64), 'base64');

        const s3ParamsDepois = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `depois_${projectName}.jpg`,
            Body: processedImageBuffer,
            ContentType: 'image/jpeg'
        };
        await s3.putObject(s3ParamsDepois).promise();
        const imageUrlDepois = `${process.env.S3_BUCKET_URL}/${s3ParamsDepois.Key}`;

        const dbParams = {
            TableName: process.env.DYNAMODB_TABLE_NAME,
            Item: {
                id: projectName,
                text: text,
                environment: environment,
                projectName: projectName,
                imageUrlAntes: imageUrlAntes,
                imageUrlDepois: imageUrlDepois,
                user: user,
                architecturalStyle: architecturalStyle,
                weather: weather,
                additionalOptions: additionalOptions,
                hours: hours,
                status: 'visível'
            }
        };
        await dynamodb.put(dbParams).promise();

        return {
            statusCode: 200,
            body: JSON.stringify({ imageUrl: imageUrlDepois })
        };
    } catch (error) {
        console.error('Erro:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
