// A Node-side mirror of the browser `RTCIceServer` shape. We do NOT pull the DOM lib
// into a server tsconfig just for one structural type — this is the minimal subset
// the client's RTCPeerConnection accepts. Serialized straight into the `joined`
// signaling response.
export interface IceServer {
  /** One ICE server URL (stun:/turn:/turns:). Single-url form keeps the client mapping trivial. */
  urls: string;
  /** coturn REST username `<expiry>:<id>` — omitted for credential-less STUN. */
  username?: string;
  /** base64(HMAC-SHA1(secret, username)) — omitted for STUN. */
  credential?: string;
}
