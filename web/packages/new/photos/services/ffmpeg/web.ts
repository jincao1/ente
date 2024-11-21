import { newID } from "@/base/id";
import log from "@/base/log";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import {
    ffmpegPathPlaceholder,
    inputPathPlaceholder,
    outputPathPlaceholder,
} from "./constants";
import QueueProcessor from "@ente/shared/utils/queueProcessor";

/** Lazily initialized and loaded FFmpeg instance. */
let _ffmpeg: Promise<FFmpeg> | undefined;

/** Queue of in-flight requests. */
const _ffmpegTaskQueue = new QueueProcessor<Uint8Array>();

/**
 * Return the shared {@link FFmpeg} instance, lazily creating and loading it if
 * needed.
 */
const ffmpegLazy = (): Promise<FFmpeg> => (_ffmpeg ??= createFFmpeg());

const createFFmpeg = async () => {
    const ffmpeg = new FFmpeg();
    // This loads @ffmpeg/core from its CDN:
    // https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
    // https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
    await ffmpeg.load();
    return ffmpeg;
};

/**
 * Run the given FFmpeg command using a wasm FFmpeg running in a web worker.
 *
 * This is a sibling of {@link ffmpegExec} exposed by the desktop app in `ipc.ts`.
 * As a rough ballpark, currently the native FFmpeg integration in the desktop
 * app is 10-20x faster than the wasm one. See: [Note: FFmpeg in Electron].
 *
 * @param command The FFmpeg command to execute.
 *
 * @param blob The input data on which to run the command, provided as a blob.
 *
 * @param outputFileExtension The extension of the (temporary) output file which
 * will be generated by the command.
 *
 * @returns The contents of the output file generated as a result of executing
 * {@link command} on {@link blob}.
 */
export const ffmpegExecWeb = async (
    command: string[],
    blob: Blob,
    outputFileExtension: string,
): Promise<Uint8Array> => {
    const ffmpeg = await ffmpegLazy();
    // Interleaving multiple ffmpeg.execs causes errors like
    //
    // >  "Out of bounds memory access (evaluating 'Module["_malloc"](len)')"
    //
    // So serialize them using a promise queue.
    const request = _ffmpegTaskQueue.queueUpRequest(() =>
        ffmpegExec(ffmpeg, command, outputFileExtension, blob),
    );
    return await request.promise;
};

const ffmpegExec = async (
    ffmpeg: FFmpeg,
    command: string[],
    outputFileExtension: string,
    blob: Blob,
) => {
    const inputPath = newID("in_");
    const outputSuffix = outputFileExtension ? "." + outputFileExtension : "";
    const outputPath = newID("out_") + outputSuffix;

    const cmd = substitutePlaceholders(command, inputPath, outputPath);

    const inputData = new Uint8Array(await blob.arrayBuffer());

    try {
        const startTime = Date.now();

        await ffmpeg.writeFile(inputPath, inputData);
        await ffmpeg.exec(cmd);

        const result = await ffmpeg.readFile(outputPath);
        if (typeof result == "string") throw new Error("Expected binary data");

        const ms = Date.now() - startTime;
        log.debug(() => `[wasm] ffmpeg ${cmd.join(" ")} (${ms} ms)`);
        return result;
    } finally {
        try {
            await ffmpeg.deleteFile(inputPath);
        } catch (e) {
            log.error(`Failed to remove input ${inputPath}`, e);
        }
        try {
            await ffmpeg.deleteFile(outputPath);
        } catch (e) {
            log.error(`Failed to remove output ${outputPath}`, e);
        }
    }
};

const substitutePlaceholders = (
    command: string[],
    inputFilePath: string,
    outputFilePath: string,
) =>
    command
        .map((segment) => {
            if (segment == ffmpegPathPlaceholder) {
                return undefined;
            } else if (segment == inputPathPlaceholder) {
                return inputFilePath;
            } else if (segment == outputPathPlaceholder) {
                return outputFilePath;
            } else {
                return segment;
            }
        })
        .filter((s) => s !== undefined);
