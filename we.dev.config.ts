import { defineConfig } from "@lightningrodlabs/we-dev-cli";

export default defineConfig({
  groups: [
    {
      name: "Tennis Club",
      networkSeed: "098rc1m-09384u-crm-29384u-cmkj",
      icon: {
        type: "filesystem",
        path: "./ui/tennis_club.png",
      },
      creatingAgent: {
        agentIdx: 1,
        agentProfile: {
          nickname: "Gaston",
          avatar: {
            type: "filesystem",
            path: "./ui/gaston.jpeg",
          },
        },
      },
      joiningAgents: [
        {
          agentIdx: 2,
          agentProfile: {
            nickname: "Marsupilami",
            avatar: {
              type: "filesystem",
              path: "./ui/marsupilami.jpeg",
            },
          },
        },
      ],
      applets: [
        {
          name: "presence.",
          instanceName: "presence.",
          registeringAgent: 1,
          joiningAgents: [2],
        },
      ],
    },
  ],
  applets: [
    {
      name: "presence.",
      subtitle: "video calls",
      description:
        "Be present.",
      icon: {
        type: "filesystem",
        path: "./ui/icon.png",
      },
      source: {
        type: "localhost",
        happPath: "./workdir/unzoom.happ",
        uiPort: 8888,
      },
    },
  ],
});
