import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { repos } from "../db";
import { ApiError } from "../http/errors";
import {
  parseBody,
  RemoteAttachmentDownloadSchema,
  RemoteAttachmentUploadSchema,
  RemoteDeviceAuthenticateSchema,
  RemoteGrantConsumeSchema,
  RemoteLeaseCheckSchema,
} from "../lib/validation";
import { REMOTE_REAUTH_MS } from "../config";

const remote = new Hono<AppEnv>();

function equalSecret(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

// Who is calling. The shared secret is the hosted gateway and answers for the
// devices with no gateway of their own (`null`); a registered gateway's token
// answers only for the devices bound to it. The scope is read from the token,
// never from the request body.
interface GatewayScope {
  gatewayId: string | null;
}

async function gatewayScope(c: Context<AppEnv>): Promise<GatewayScope> {
  const expected = c.env.REMOTE_GATEWAY_TOKEN;
  const supplied = c.req.header("x-reasonix-gateway-token");
  if (supplied && expected && equalSecret(supplied, expected)) return { gatewayId: null };
  if (supplied) {
    // A lookup that cannot be answered is a refusal, never a pass.
    const own = await repos(c.env).remoteGateways.authenticate(supplied).catch(() => null);
    if (own) return { gatewayId: own.id };
  }
  if (!expected && !supplied) throw new ApiError(503, "remote_unavailable", "Remote access is not configured.");
  throw new ApiError(401, "unauthorized_gateway", "Gateway authentication failed.");
}

remote.use("*", async (c, next) => {
  c.set("gatewayScope", await gatewayScope(c));
  await next();
});

// Attachments live in the hosted bucket; a gateway that is not the hosted one
// has no business authorizing them.
remote.use("/attachments/*", async (c, next) => {
  if (c.get("gatewayScope").gatewayId !== null) {
    throw new ApiError(403, "gateway_scope", "This gateway cannot handle attachments.");
  }
  await next();
});

remote.post("/devices/authenticate", async (c) => {
  const { deviceId, deviceCredential } = await parseBody(c, RemoteDeviceAuthenticateSchema);
  const authenticated = await repos(c.env).remoteDevices.authenticate(deviceId, deviceCredential, c.get("gatewayScope").gatewayId);
  if (!authenticated) throw new ApiError(401, "invalid_device", "The device credential is invalid or revoked.");
  return c.json(authenticated);
});

remote.post("/grants/consume", async (c) => {
  const { ticket } = await parseBody(c, RemoteGrantConsumeSchema);
  const grant = await repos(c.env).remoteDevices.consumeGrant(ticket, c.get("gatewayScope").gatewayId);
  if (!grant) throw new ApiError(401, "invalid_grant", "The connection grant is invalid, expired, or already used.");
  const { sessionId, authenticatedAt, ...admitted } = grant;
  const signedIn = authenticatedAt ? Date.parse(authenticatedAt) : Number.NaN;
  return c.json({
    grant: {
      ...admitted,
      ...(sessionId ? { sessionId } : {}),
      ...(Number.isFinite(signedIn) ? { reauthAt: new Date(signedIn + REMOTE_REAUTH_MS).toISOString() } : {}),
    },
  });
});

remote.post("/leases/check", async (c) => {
  const { leases } = await parseBody(c, RemoteLeaseCheckSchema);
  const signedInAfter = new Date(Date.now() - REMOTE_REAUTH_MS).toISOString();
  const verdicts = await repos(c.env).remoteDevices.checkLeases(leases, signedInAfter, c.get("gatewayScope").gatewayId);
  return c.json({ verdicts });
});

remote.post("/attachments/upload", async (c) => {
  const input = await parseBody(c, RemoteAttachmentUploadSchema);
  const attachment = await repos(c.env).remoteAttachments.consumeUpload(input);
  if (!attachment) throw new ApiError(401, "invalid_attachment_grant", "The upload grant is invalid or expired.");
  return c.json({ attachment });
});

remote.post("/attachments/download", async (c) => {
  const { objectId, ticket } = await parseBody(c, RemoteAttachmentDownloadSchema);
  const attachment = await repos(c.env).remoteAttachments.authorizeDownload(objectId, ticket);
  if (!attachment) throw new ApiError(401, "invalid_attachment_grant", "The download grant is invalid or expired.");
  return c.json({ attachment });
});

export default remote;
