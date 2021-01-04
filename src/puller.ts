import * as https from "https";
import * as fs from "fs";
import { MicroWriter, MicroWriterOptions, MicroWriterConfig } from "microprediction";

const shell = require('any-shell-escape')
const { exec } = require('child_process');

const bent = require('bent');
const getBuffer = bent('buffer');

// Publish updates on a five minute interval.
const window_length = 1000 * 10;

// If a sample has an absolute value larger than this it is
// considered not "silent".
const loud_threshold = 3000;

let config: MicroWriterOptions | undefined;

/**
 * This function analyzes all of the audio data delivered in
 * MPEG format, and determines how much of that data represents
 * silence by comparing the PCM sample value versus a fixed
 * threshold.
 *
 * This function then publishes the percentage of the interval time
 * that was silence to Microprediction.org
 *
 * @param data the data received from the streaming server
 */
async function analyze_data(data: Buffer, stream_description: string) {
    const sample_rate = 16000;

    const audio_filename = `/tmp/scanner-audio.${(new Date()).getTime()}.${Math.round(Math.random() * 100000)}.mpeg`;
    fs.writeFileSync(audio_filename, data);
    const makePCM = shell([
        'ffmpeg', '-i', audio_filename,
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ar', sample_rate,
        '-'
    ])

    exec(makePCM, {
        maxBuffer: 1024 * 1024 * 5,
        encoding: null,
    },
        async (err, stdout) => {
            fs.unlinkSync(audio_filename);
            if (err) {
                console.error(err)
                process.exit(1)
            } else {
                const pcm_values = new Int16Array(stdout.length / 2);
                for (let i = 0; i < stdout.length; i += 2) {
                    pcm_values[i / 2] = Math.abs(stdout.readInt16LE(i));
                }

                if (pcm_values.length > (window_length / 1000) * sample_rate * 1.2) {
                    return;
                }

                const loud_indexes = [0];
                pcm_values.forEach((v, idx) => {
                    if (v > loud_threshold) {
                        loud_indexes.push(idx);
                    }
                });
                loud_indexes.push(pcm_values.length - 1);

                //console.log("Loud indexes: ", loud_indexes.length);
                //console.log("Total samples: ", pcm_values.length);

                const diff_indexes: number[] = [];

                let total_silence_seconds = 0;

                if (loud_indexes.length < 2) {
                    total_silence_seconds = window_length / 1000;
                }
                for (let i = 1; i < loud_indexes.length; i++) {
                    const sample_dist = loud_indexes[i] - loud_indexes[i - 1];
                    if (sample_dist > (sample_rate * .25)) {
                        diff_indexes.push(sample_dist);
                        // console.log("Interval:", sample_dist / sample_rate);
                        total_silence_seconds += sample_dist / sample_rate;
                    }
                }

                total_silence_seconds = Math.min(total_silence_seconds, window_length / 1000);[]
                //                console.log("Total silence:", total_silence_seconds);
                const percent_silent = total_silence_seconds / (window_length / 1000);
                console.log("Silence Percentage", percent_silent);

                const active_percent = 1.0 - percent_silent;

                if (config == null) {
                    const write_key = process.env["MICROPREDICTION_WRITE_KEY"];
                    if (write_key == null) {
                        throw new Error("No MICROPREDICTION_WRITE_KEY defined");
                    }

                    config = await MicroWriterConfig.create({
                        write_key,
                    });
                }

                if (config != null) {
                    const writer = new MicroWriter(config);

                    const clean_description = stream_description.replace(/[ \.,\(\)\-]/g, '_')
                        .replace(/_+/g, '_')
                        .toLowerCase();

                    console.log(clean_description);
                    await writer.set(`scanner-audio-${clean_description}.json`, active_percent);
                }
            }
        })
}


/**
 * Request live streaming data from the stream provider, then
 * periodically analyze the received data.
 *
 * @param stream_id The unique stream identifier
 * @param description The description or title of the stream, this will
 * be used to determine the Microprediction stream name.
 */
function listenToStream(stream_id: number, description: string) {

    const options = {
        hostname: 'broadcastify.cdnstream1.com',
        port: 443,
        headers: {
            'sec-ch-ua-mobile': '?0',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36',
            'Accept': '*/*',
            'Origin': 'https://www.broadcastify.com',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'audio',
            'Referer': 'https://www.broadcastify.com/',
            'Accept-Language': 'en-US,en;q=0.9',
            'Range': 'bytes=0-'
        },
        path: `/${stream_id}`,
        method: 'GET'
    };


    const interval_data: Buffer[] = [];
    const req = https.request(options, (res) => {
        //        console.log('statusCode:', res.statusCode);
        if (res.statusCode !== 200) {
            console.error(`Bad stream HTTP status code (${stream_id}) (${description}) ${res.statusCode}, will retry`);
            setTimeout(listenToStream, 5000);
            return;
        }
        //        console.log('headers:', res.headers);

        const timeout_handler = () => {
            // Make one large buffer containing all of the partial
            // response data.
            const final_data = Buffer.concat(interval_data);
            // Remove all of the previously received buffers of data
            interval_data.splice(0);

            // Start a new timer for a sampling interval.
            setTimeout(timeout_handler, window_length);
            // Send the data to ffmpeg and parse out the values.
            analyze_data(final_data, description);
        };
        setTimeout(timeout_handler, window_length);

        res.on('data', (d) => {
            //            console.log(`Read data: ${d.length}`);
            interval_data.push(d);
        });

        res.once('end', () => {
            console.log(`Reached the end of the stream`);
            // Try to listen again after 2 seconds.
            setTimeout(listenToStream, 2000);
        })
    });

    req.on('error', (e) => {
        console.error(`Error receiving stream: ${e}`);
        // Try to listen again after 2 seconds.
        setTimeout(listenToStream, 2000);
    });
    req.end();
}


/**
 * Listen to a collection of streams.
 *
 * @param stream_ids A collection of unique stream ids.
 */
async function listenStreams(stream_ids: number[]) {
    for (const stream_id of stream_ids) {
        const info = await getBuffer(`https://www.broadcastify.com/webPlayer/${stream_id}`);

        // It is never a good idea to parse HTML using a regular expression
        // but these pages are so simple, and I'm being lazy.
        const title_match = info.toString('utf8').match(/<title>(.*)<\/title>/);

        if (title_match == null) {
            throw new Error(`Failed to parse stream title of ${stream_id}`);
        }

        const stream_title = title_match[1].replace(/ Live Audio Feed$/, '').trim();
        console.log(`Starting listening to ${stream_title}`);

        listenToStream(stream_id, stream_title);
    }
}

// This is just an example collection of streams.
const stream_ids = [32304, 33162, 19349, 9358, 1189, 29658, 2668, 33453, 22184, 27326,
    3246, 9803, 9059, 9466, 32917, 31143, 27800, 32942, 32913,
    29658, 28826, 26857];

listenStreams(stream_ids);