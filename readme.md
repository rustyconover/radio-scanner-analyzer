# Radio Scanner Streams input to Microprediction.org

There are many online radio scanners, they listen for
activity on the fire, police, aviation or railroad frequencies
and broadcast what they hear to the Internet.

The broadcasts are using MPEG audio and served via HTTPS
as such it is reasonably easy to capture the audio stream for
a fixed amount of them, then detect the periods of silence.

This code is a framework for listening to multiple scanner
streams, and determining how much silence there was over a
fixed interval of time. The code then publishes the number
of seconds where there was "activity" on the stream as a time
series so other programs can build models and predict it.

Ideally these models would be a part of ensemble of models to
perform anonomly detection. There is likely a baseline of activity
that occurrs on all of these channels, detecting deviations from
that baseline may signal events of interest are occurring.

# Code

See `src/puller.ts` for the code.

Run the code with `ts-node src/puller.ts`
