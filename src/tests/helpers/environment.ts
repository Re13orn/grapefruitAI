import { createServer } from "node:http";

export interface AvailabilityProbe {
  ok: boolean;
  reason?: string;
}

export function getUDID(): string | null {
  const udid = process.env.UDID;
  return typeof udid === "string" && udid.length > 0 ? udid : null;
}

export async function probeLocalTcpListener(
  host = "127.0.0.1",
): Promise<AvailabilityProbe> {
  const server = createServer();

  return await new Promise<AvailabilityProbe>((resolve) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      resolve({ ok: false, reason: err.message });
    };

    const onListening = () => {
      server.off("error", onError);
      server.close(() => resolve({ ok: true }));
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}
