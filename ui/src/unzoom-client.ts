import { ZomeClient } from "@holochain-open-dev/utils";
import { AgentPubKey, AppAgentClient, RoleName, encodeHashToBase64 } from "@holochain/client";
import { InitAcceptInput, InitRequestInput, SdpDataInput, UnzoomSignal } from "./unzoom/unzoom/types";


export class UnzoomClient extends ZomeClient<UnzoomSignal> {
  constructor(
    public client: AppAgentClient,
    public roleName: RoleName,
    public zomeName = "unzoom"
  ) {
    super(client, roleName, zomeName);
  }

  async getAllAgents(): Promise<AgentPubKey[]> {
    return this.callZome("get_all_agents", null);
  }

  /**
   * Ping all given agents, listening for their pong later
   */
  async ping(agentPubKeys: AgentPubKey[]): Promise<void> {
    return this.callZome("ping", agentPubKeys);
  }

  async sendInitRequest(payload: InitRequestInput): Promise<void> {
    return this.callZome("send_init_request", payload);
  }

  async sendInitAccept(payload: InitAcceptInput): Promise<void> {
    return this.callZome("send_init_accept", payload);
  }

  async sendSdpData(payload: SdpDataInput): Promise<void> {
    return this.callZome("send_sdp_data", payload);
  }
}
