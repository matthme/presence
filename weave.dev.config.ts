import { defineConfig } from "@theweave/cli";

export default defineConfig({
  toolCurations: [],
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
        {
          agentIdx: 3,
          agentProfile: {
            nickname: "Marsupilami Nr. 2",
            avatar: {
              type: "filesystem",
              path: "./ui/marsupilami.jpeg",
            },
          },
        },
      ],
      applets: [
        {
          name: "presence",
          instanceName: "presence",
          registeringAgent: 1,
          joiningAgents: [2],
        },
        // {
        //   name: 'ZipZap',
        //   instanceName: 'ZipZap',
        //   registeringAgent: 1,
        //   joiningAgents: [2],
        // },
        // {
        //   name: 'KanDo',
        //   instanceName: 'KanDo',
        //   registeringAgent: 1,
        //   joiningAgents: [2],
        // },
      ],
    },
  ],
  applets: [
    {
      name: "presence",
      subtitle: "video calls",
      description:
        "Be present.",
      icon: {
        type: "filesystem",
        path: "./ui/icon.png",
      },
      source: {
        type: "localhost",
        happPath: "/home/matthias/code/holochain/matthme/presence/workdir/presence.happ",
        uiPort: 8888,
      },
    },
    {
      name: "presence webhapp",
      subtitle: "video calls",
      description:
        "Be present.",
      icon: {
        type: "filesystem",
        path: "./ui/icon.png",
      },
      source: {
        type: "filesystem",
        path: "/home/matthias/code/holochain/matthme/presence/workdir/presence.webhapp",
      },
    },
    {
      name: 'KanDo',
      subtitle: 'KanBan board on Holochain',
      description: 'KanBan board',
      icon: {
        type: 'https',
        url: 'https://theweave.social/images/kando_icon.png',
      },
      source: {
        type: 'https',
        url: 'https://github.com/holochain-apps/kando/releases/download/v0.12.0-rc.1/kando.webhapp',
      },
    },
    {
      name: 'ZipZap',
      subtitle: 'Ephemeral direct messaging',
      description: 'Ephemeral direct messaging',
      icon: {
        type: 'https',
        url: 'https://lightningrodlabs.org/projects/notebooks.png',
      },
      source: {
        type: 'https',
        url: 'https://github.com/lightningrodlabs/zipzap/releases/download/v0.1.3/zipzap.webhapp',
      },
    },
  ],
});
