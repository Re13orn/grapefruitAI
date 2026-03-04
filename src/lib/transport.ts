import RemoteStreamController from "frida-remote-stream";
import type { Device, ScriptExports, ScriptMessageHandler } from "./xvii.ts";
import { agent } from "./assets.ts";

export class Transport {
  private closed = false;

  constructor(
    public readonly script: {
      exports: ScriptExports;
      unload: () => Promise<void>;
      message: { connect: (handler: ScriptMessageHandler) => void };
      post: (message: object, data?: Buffer | null) => void;
    },
    public readonly session: { detach: () => Promise<void> },
    public readonly controller: RemoteStreamController,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const [unloadResult, detachResult] = await Promise.allSettled([
      this.script.unload(),
      this.session.detach(),
    ]);

    if (unloadResult.status === "rejected") {
      throw unloadResult.reason;
    }
    if (detachResult.status === "rejected") {
      throw detachResult.reason;
    }
  }
}

export async function create(device: Device, pid: number): Promise<Transport> {
  const agentSource = await agent("transport");
  const session = await device.attach(pid);
  const script = await session.createScript(agentSource);
  await script.load();

  const controller = new RemoteStreamController();
  controller.events.on("send", ({ stanza, data }) => {
    script.post(
      {
        type: "+stream",
        payload: stanza,
      },
      data,
    );
  });

  script.message.connect((message, data) => {
    if (message.type === "send") {
      const stanza = message.payload as {
        payload: { [key: string]: any };
        name: string;
      };
      if (stanza.name === "+stream") {
        controller.receive({
          stanza: stanza.payload,
          data,
        });
      }
    }
  });

  return new Transport(script, session, controller);
}
