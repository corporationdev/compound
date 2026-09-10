import { test, expect } from 'bun:test';
import { Output, AudioSample, AudioSampleSource } from 'mediabunny';
import { createOutputFormat } from '../src/format';
import { TargetBuffer } from '../src/buffer';

test('caption encoder writes mono PCM16 WAV with exact sample duration', async () => {
  const target = await TargetBuffer.create();
  const output = new Output({ target: target.target, format: await createOutputFormat(target, 'wav') });
  const source = new AudioSampleSource({ codec: 'pcm-s16' });
  output.addAudioTrack(source);
  await output.start();
  const sample = new AudioSample({ format: 'f32-planar', data: new Float32Array(16000).fill(.25), sampleRate: 16000, numberOfChannels: 1, timestamp: 0 });
  await source.add(sample);
  sample.close();
  await output.finalize();
  const blob = (await target.close('wav'))!;
  expect(blob.type).toBe('audio/wav');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { readPcmWavMetadata } = await import('../../backend/lib/transcription/audio');
  expect(await readPcmWavMetadata(async (offset, length) => bytes.subarray(offset, offset + length))).toMatchObject({ durationUs: 1000000, dataLength: 32000 });
});
