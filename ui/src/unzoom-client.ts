import { ZomeClient } from "@holochain-open-dev/utils";
import { AgentPubKey, AppAgentClient, RoleName } from "@holochain/client";
import { SdpOfferInput, SdpResponseInput, UnzoomSignal } from "./unzoom/unzoom/types";


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

  async sendOffer(offer: SdpOfferInput): Promise<void> {
    return this.callZome("send_offer", offer);
  }

  async sendResponse(response: SdpResponseInput): Promise<void> {
    return this.callZome("send_response", response);
  }
}
