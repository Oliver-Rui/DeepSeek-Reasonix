import { describe, expect, it } from "vitest";
import { acceptablePushEndpoint, acceptablePushKeys } from "./endpoint";
import { base64url } from "./encoding";

describe("the push services a subscription may name", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QAbc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", (endpoint) => {
    expect(acceptablePushEndpoint(endpoint)).not.toBeNull();
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com/x#frag",
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://notfcm.googleapis.com.example/x",
    "https://xfcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://169.254.169.254/latest",
    "https://localhost/x",
    "https://fcm.googleapis.com./x",
    "ftp://fcm.googleapis.com/x",
    "not a url",
    "",
    `https://fcm.googleapis.com/${"a".repeat(2100)}`,
  ])("refuses %s", (endpoint) => {
    expect(acceptablePushEndpoint(endpoint)).toBeNull();
  });
});

describe("the keys a browser sends", () => {
  const point = new Uint8Array(65).fill(7);
  point[0] = 4;
  const good = { p256dh: base64url(point), auth: base64url(new Uint8Array(16).fill(1)) };

  it("accepts an uncompressed point and a 16 octet secret", () => {
    expect(acceptablePushKeys(good)).not.toBeNull();
  });

  it("refuses the wrong shape, length or alphabet", () => {
    const compressed = new Uint8Array(33).fill(7);
    compressed[0] = 2;
    expect(acceptablePushKeys({ ...good, p256dh: base64url(compressed) })).toBeNull();
    expect(acceptablePushKeys({ ...good, auth: base64url(new Uint8Array(15)) })).toBeNull();
    expect(acceptablePushKeys({ ...good, auth: base64url(new Uint8Array(17)) })).toBeNull();
    expect(acceptablePushKeys({ ...good, p256dh: "not base64!" })).toBeNull();
    expect(acceptablePushKeys({ ...good, p256dh: `${good.p256dh}=` })).toBeNull();
  });
});
