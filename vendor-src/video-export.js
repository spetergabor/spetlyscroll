import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";

async function createConversion({ blob, width, height, renderFrame, onProgress, keepAudio }) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: {
      codec: "avc",
      quality: new Quality({ bitrate: 8_000_000 }),
      frameRate: 30,
      forceTranscode: true,
      processedWidth: width,
      processedHeight: height,
      process: async (sample) => renderFrame(sample),
    },
    audio: keepAudio
      ? { codec: "aac", quality: new Quality({ bitrate: 192_000 }), forceTranscode: true }
      : { discard: true },
  });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((entry) => entry.reason).join(", ") || "unsupported codec";
    await output.cancel();
    throw new Error(reasons);
  }
  if (onProgress) conversion.onProgress = onProgress;
  await conversion.execute();
  if (!output.target.buffer) throw new Error("The MP4 encoder did not return a file");
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

async function transcodeToInstagramMp4(options) {
  try {
    return { blob: await createConversion({ ...options, keepAudio: true }), muted: false };
  } catch (error) {
    console.warn("MP4 audio encoding was unavailable; retrying without audio", error);
    return { blob: await createConversion({ ...options, keepAudio: false }), muted: true };
  }
}

window.SpetlyVideo = { transcodeToInstagramMp4 };
