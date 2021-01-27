import * as https from "https";
import * as fs from "fs";
import { MicroWriter, MicroWriterOptions, MicroWriterConfig } from "microprediction";
import { execSync } from "child_process";

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
async function analyze_data(data: Buffer, stream_description: string): Promise<void> {
    const sample_rate = 16000;

    const audio_filename = `/tmp/scanner-audio.${(new Date()).getTime()}.${Math.round(Math.random() * 100000)}.mpeg`;
    const pcm_output = `/tmp/scanner-pcm.${(new Date()).getTime()}.${Math.round(Math.random() * 100000)}.data`;

    fs.writeFileSync(audio_filename, data);
    const makePCM = shell([
        'ffmpeg', '-i', audio_filename,
        '-hide_banner',
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ar', sample_rate,
        pcm_output,
    ])

    // Now here is where the problem can be, if there are too many
    // streams being analyzed at once.
    try {
        execSync(makePCM, {
            maxBuffer: 1024 * 1024 * 64,
            encoding: null,
        });
    } catch (e) {
        console.error("Error running ffmpeg");
        console.error(e);
        console.log("Returning");
        return;
    } finally {
        fs.unlinkSync(audio_filename);
    }

    const loud_indexes = [0];
    {
        const pcm_data = fs.readFileSync(pcm_output, { encoding: null });
        fs.unlinkSync(pcm_output);
        const pcm_values = new Int16Array(pcm_data.buffer);

        if (pcm_values.length > (window_length / 1000) * sample_rate * 1.2) {
            return;
        }

        pcm_values.forEach((v, idx) => {
            if (Math.abs(v) > loud_threshold) {
                loud_indexes.push(idx);
            }
        });
        loud_indexes.push(pcm_values.length - 1);
        //                    console.log("Total samples: ", pcm_values.length);
    };

    //                console.log("Loud indexes: ", loud_indexes.length);

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

    const writer = new MicroWriter(config);

    const clean_description = stream_description.replace(/[ \.,\(\)\-\/]/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();

    console.log(clean_description);
    await writer.set(`scanner-audio-${clean_description}.json`, active_percent);
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
            console.error(`Bad stream HTTP status code (${stream_id}) (${description}) ${res.statusCode}`);
            if (res.statusCode === 404) {
                return;
            }
            setTimeout(listenToStream, 5000, stream_id, description);
            return;
        }
        //        console.log('headers:', res.headers);

        const timeout_handler = async () => {
            // Make one large buffer containing all of the partial
            // response data.
            const final_data = Buffer.concat(interval_data);
            // Remove all of the previously received buffers of data
            interval_data.splice(0);

            // Start a new timer for a sampling interval.
            setTimeout(timeout_handler, window_length);
            // Send the data to ffmpeg and parse out the values.

            try {
                await analyze_data(final_data, description);
            } catch (e) {
                // Cancel this request, since the data was corrupted.
                req.abort();
                interval_data.splice(0);
                setTimeout(listenToStream, 2000, stream_id, description);
            }
        };
        setTimeout(timeout_handler, window_length);

        res.on('data', (d) => {
            //            console.log(`Read data: ${d.length}`);
            interval_data.push(d);
        });

        res.once('end', () => {
            console.log(`Reached the end of the stream`);
            // Try to listen again after 2 seconds.
            setTimeout(listenToStream, 2000, stream_id, description);
        })
    });

    req.on('error', (e) => {
        console.error(`Error receiving stream: ${e}`);
        // Try to listen again after 2 seconds.
        setTimeout(listenToStream, 2000, stream_id, description);
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
const stream_ids = new Set([32304, 33162, 19349, 9358, 1189, 2668, 33453, 22184, 27326,
    3246, 9803, 9059, 9466, 32917, 31143, 27800, 32942, 32913,
    28826, 26857,
    10277,
    10294,
    1102,
    11208,
    11446,
    13544,
    13549,
    13671,
    13743,
    13853,
    13928,
    14395,
    16904,
    1813,
    188,
    19053,
    19080,
    19346,
    21738,
    22101,
    22346,
    2344,
    24550,
    25304,
    25467,
    2648,
    26699,
    26933,
    27719,
    28068,
    2858,
    29604,
    30088,
    30587,
    30589,
    31352,
    31779,
    32252,
    32602,
    33016,
    34105,
    3691,
    3737,
    4142,
    5163,
    5623,
    5725,
    602,
    9059,
    9358,
]);

listenStreams(Array.from(stream_ids));