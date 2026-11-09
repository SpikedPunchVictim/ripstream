import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { PdfSession, type PdfRequest, type PdfSessionInput } from "./pdf-session.ts";

/**
 * Worker-thread entry: serves one PdfSession over the parent port. The logic
 * lives in pdf-session.ts so the parser can also run it on its own thread.
 */
if (parentPort !== null) {
  void serve(parentPort, workerData as PdfSessionInput);
}

async function serve(port: MessagePort, input: PdfSessionInput): Promise<void> {
  const session = new PdfSession(input);
  const opened = await session.open();
  port.postMessage(opened);
  if (opened.type !== "ready") return;

  port.on("message", (request: PdfRequest) => {
    void session.handle(request).then((response) => {
      port.postMessage(response);
      if (response.type === "closed") port.close();
    });
  });
}
