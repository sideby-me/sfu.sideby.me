// Router media codecs (SFU-07). The Router advertises exactly these to every
// client; the client's mediasoup-client Device loads them and negotiates the
// intersection. VP8 + H264 video + Opus audio.
//
// H264 MUST carry its parameters block — `packetization-mode`, `profile-level-id`
// (42e01f = constrained baseline, broad browser support) and `level-asymmetry-allowed`.
// Omitting them does NOT error: the browser silently degrades to VP8-only, so the
// "H264 supported" claim quietly becomes false (RESEARCH §H264 profile-level-id gotcha).
// RouterRtpCodecCapability (not RtpCodecCapability) is the type RouterOptions.mediaCodecs
// expects — it makes preferredPayloadType optional (mediasoup assigns dynamic PTs).
import type { RouterRtpCodecCapability } from 'mediasoup/types';

export const mediaCodecs: RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f', // constrained baseline — broad browser support
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];
