import {
  client,
  methods,
  type Client,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  GOOSE_EXT_AGENT_REQUESTS,
  GOOSE_EXT_NOTIFICATIONS,
  GooseExtClient,
  type ConfirmOverwriteRequest_unstable,
  type ConfirmOverwriteResponse_unstable,
  type EnsureCheckpointRequest_unstable,
  type EnsureCheckpointResponse_unstable,
  type GooseSessionNotification_unstable,
  type ProviderDeviceCodeNotification_unstable,
  type RecipeParamsResponse_unstable,
  type RequestRecipeParams_unstable,
  type RunFinishedNotification_unstable,
  type RunStartedNotification_unstable,
  zConfirmOverwriteRequest_unstable,
  zEnsureCheckpointRequest_unstable,
  zGooseSessionNotification_unstable,
  zProviderDeviceCodeNotification_unstable,
  zRequestRecipeParams_unstable,
  zRunFinishedNotification_unstable,
  zRunStartedNotification_unstable,
} from '@aaif/goose-acp-client';

const [gooseSessionUpdate, providerDeviceCode, runStarted, runFinished] = GOOSE_EXT_NOTIFICATIONS;
const [gooseRecipeParamsRequest, gooseCheckpointEnsureRequest, gooseConfirmOverwriteRequest] =
  GOOSE_EXT_AGENT_REQUESTS;

export type GooseAcpCallbacks = Required<
  Pick<Client, 'requestPermission' | 'sessionUpdate' | 'unstable_createElicitation'>
> & {
  unstable_sessionRecipeRequestParams: (
    request: RequestRecipeParams_unstable
  ) => Promise<RecipeParamsResponse_unstable>;
  unstable_sessionCheckpointEnsure: (
    request: EnsureCheckpointRequest_unstable
  ) => Promise<EnsureCheckpointResponse_unstable>;
  unstable_tasksConfirmOverwrite: (
    request: ConfirmOverwriteRequest_unstable
  ) => Promise<ConfirmOverwriteResponse_unstable>;
  unstable_sessionUpdate: (notification: GooseSessionNotification_unstable) => Promise<void>;
  unstable_providerDeviceCode: (
    notification: ProviderDeviceCodeNotification_unstable
  ) => Promise<void>;
  unstable_runsStarted: (notification: RunStartedNotification_unstable) => Promise<void>;
  unstable_runsFinished: (notification: RunFinishedNotification_unstable) => Promise<void>;
};

export type GooseAcpClient = {
  connection: ClientConnection;
  goose: GooseExtClient;
};

export function connectGooseAcpClient(
  stream: Stream,
  callbacks: GooseAcpCallbacks
): GooseAcpClient {
  const app = client({ name: 'goose' })
    .onRequest(methods.client.session.requestPermission, (context) =>
      callbacks.requestPermission(context.params)
    )
    .onNotification(methods.client.session.update, (context) =>
      callbacks.sessionUpdate(context.params)
    )
    .onRequest(methods.client.elicitation.create, (context) =>
      callbacks.unstable_createElicitation(context.params)
    )
    .onRequest(gooseRecipeParamsRequest.method, zRequestRecipeParams_unstable, (context) =>
      callbacks.unstable_sessionRecipeRequestParams(context.params)
    )
    .onRequest(
      gooseCheckpointEnsureRequest.method,
      zEnsureCheckpointRequest_unstable,
      (context) => callbacks.unstable_sessionCheckpointEnsure(context.params)
    )
    .onRequest(gooseConfirmOverwriteRequest.method, zConfirmOverwriteRequest_unstable, (context) =>
      callbacks.unstable_tasksConfirmOverwrite(context.params)
    )
    .onNotification(gooseSessionUpdate.method, zGooseSessionNotification_unstable, (context) =>
      callbacks.unstable_sessionUpdate(context.params)
    )
    .onNotification(
      providerDeviceCode.method,
      zProviderDeviceCodeNotification_unstable,
      (context) => callbacks.unstable_providerDeviceCode(context.params)
    )
    .onNotification(runStarted.method, zRunStartedNotification_unstable, (context) =>
      callbacks.unstable_runsStarted(context.params)
    )
    .onNotification(runFinished.method, zRunFinishedNotification_unstable, (context) =>
      callbacks.unstable_runsFinished(context.params)
    );

  const connection = app.connect(stream);
  const goose = new GooseExtClient(connection.agent);

  return { connection, goose };
}
