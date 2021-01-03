import * as https from "https";
import * as fs from "fs";

const options = {
    hostname: 'broadcastify.cdnstream1.com',
    port: 443,
    headers: {
        //        'sec-ch-ua": '"Google Chrome"; v="87", " Not;A Brand"; v="99", "Chromium"; v="87"',
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
    path: '/32304',
    method: 'GET'
};


const shell = require('any-shell-escape')
const { exec } = require('child_process')


const window_length = 60000;
const output_filename = "one-mins.txt";
const loud_threshold = 3000;

function analyze_data(data: Buffer) {
    fs.writeFileSync("/Users/rusty/Desktop/example-audio.mpeg", data);


    const makePCM = shell([
        'ffmpeg', '-i', '/Users/rusty/Desktop/example-audio.mpeg',
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-'
    ])

    exec(makePCM, {
        maxBuffer: 1024 * 1024 * 5,
        encoding: null,
    },
        (err, stdout) => {
            if (err) {
                console.error(err)
                process.exit(1)
            } else {
                console.info('done!')
                console.log(stdout.length);

                const sample_rate = 22050;
                const pcm_values = new Int16Array(stdout.length / 2);
                for (let i = 0; i < stdout.length; i += 2) {
                    pcm_values[i / 2] = Math.abs(stdout.readInt16LE(i));
                }

                if (pcm_values.length > (window_length / 1000) * sample_rate * 1.2) {
                    return;
                }

                // Need to fix the problem with silence beginning at the start of the interval
                // to the first point,

                // and fix silence detection until the end.


                const loud_indexes = [0];
                pcm_values.forEach((v, idx) => {
                    if (v > loud_threshold) {
                        loud_indexes.push(idx);
                    }
                });
                loud_indexes.push(pcm_values.length - 1);

                console.log("Loud indexes: ", loud_indexes.length);
                console.log("Total samples: ", pcm_values.length);

                const diff_indexes = [];

                let total_silence_seconds = 0;

                if (loud_indexes.length < 2) {
                    total_silence_seconds = window_length / 1000;
                }
                for (let i = 1; i < loud_indexes.length; i++) {
                    const sample_dist = loud_indexes[i] - loud_indexes[i - 1];
                    if (sample_dist > (sample_rate * .25)) {
                        diff_indexes.push(sample_dist);
                        console.log("Interval:", sample_dist / sample_rate);
                        total_silence_seconds += sample_dist / sample_rate;
                    }
                }

                total_silence_seconds = Math.min(total_silence_seconds, window_length / 1000);[]
                console.log("Total silence:", total_silence_seconds);
                const percent_silent = total_silence_seconds / (window_length / 1000);
                console.log("Silence Percentage", percent_silent);
                fs.writeFileSync(output_filename, `${Math.round((new Date()).getTime() / 1000)} ${percent_silent}\n`, { flag: "a" });
            }
        })
}

const interval_data = [];
const req = https.request(options, (res) => {
    console.log('statusCode:', res.statusCode);
    console.log('headers:', res.headers);

    const timeout_handler = () => {
        const final_data = Buffer.concat(interval_data);
        console.log("Final data for one minute is ", final_data.length);
        interval_data.splice(0);
        setTimeout(timeout_handler, window_length);

        // Send the data to ffmpeg and parse out the values.
        analyze_data(final_data);
    };
    setTimeout(timeout_handler, window_length);

    res.on('data', (d) => {
        console.log(d.length);
        interval_data.push(d);
    });
});

req.on('error', (e) => {
    console.error(e);
});
req.end();
