import type { WorkerArtifactApi } from "@portable-devshell/shared";

export function guardArtifact(
    artifact: WorkerArtifactApi,
    assertReady: () => void,
): WorkerArtifactApi {

    return {
        abortArtifactReceive: async (receiveId) => {
            assertReady();
            await artifact.abortArtifactReceive(receiveId);
        },
        beginArtifactReceive: async (input, signal) => {
            assertReady();
            return await artifact.beginArtifactReceive(input, signal);
        },
        closeArtifactPayload: async (payloadId) => {
            assertReady();
            await artifact.closeArtifactPayload(payloadId);
        },
        finishArtifactReceive: async (receiveId) => {
            assertReady();
            return await artifact.finishArtifactReceive(receiveId);
        },
        openArtifactPayload: async (input, signal) => {
            assertReady();
            return await artifact.openArtifactPayload(input, signal);
        },
        readArtifactPayload: async (input, signal) => {
            assertReady();
            return await artifact.readArtifactPayload(input, signal);
        },
        writeArtifactReceive: async (input, signal) => {
            assertReady();
            return await artifact.writeArtifactReceive(input, signal);
        },
        ...(artifact.openArtifactDirectReceive === undefined
            ? {}
            : {
                  openArtifactDirectReceive: async (input, signal) => {
                      assertReady();
                      return await artifact.openArtifactDirectReceive!(
                          input,
                          signal,
                      );
                  },
              }),
        ...(artifact.closeArtifactDirectReceive === undefined
            ? {}
            : {
                  closeArtifactDirectReceive: async (receiverId) => {
                      assertReady();
                      await artifact.closeArtifactDirectReceive!(receiverId);
                  },
              }),
        ...(artifact.pushArtifactPayloadDirect === undefined
            ? {}
            : {
                  pushArtifactPayloadDirect: async (input) => {
                      assertReady();
                      return await artifact.pushArtifactPayloadDirect!(input);
                  },
              }),
    };
}
