const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const campaigns = new Map();
const sockets = new Map();

function makeId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function makeCode() {
  let code;

  do {
    code = `ACACADA-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (campaigns.has(code));

  return code;
}

function cleanText(value, fallback = '') {
  return String(value ?? '').trim().slice(0, 120) || fallback;
}

function publicCharacter(character) {
  return {
    id: character.id,
    ownerId: character.ownerId,
    data: character.data
  };
}

function publicCampaign(campaign) {
  return {
    code: campaign.code,
    name: campaign.name,
    masterId: campaign.masterId,

    players: [...campaign.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      role: player.role
    })),

    characters: [...campaign.characters.values()].map(publicCharacter)
  };
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function response(ws, id, ok, data, error) {
  send(ws, {
    type: 'response',
    id,
    ok,
    data,
    error
  });
}

function campaignState(campaign, player) {
  return {
    campaign: publicCampaign(campaign),

    player: {
      id: player.id,
      name: player.name,
      role: player.role
    },

    role: player.role
  };
}

function broadcastCampaign(campaign) {
  const message = {
    type: 'campaign_state',
    data: {
      campaign: publicCampaign(campaign)
    }
  };

  for (const player of campaign.players.values()) {
    if (player.ws && player.ws.readyState === 1) {
      send(player.ws, message);
    }
  }
}

function findPlayerCampaign(player) {
  return player?.campaignCode
    ? campaigns.get(player.campaignCode)
    : null;
}

function removePlayerFromCampaign(player) {
  const campaign = findPlayerCampaign(player);

  if (!campaign) {
    return;
  }

  campaign.players.delete(player.id);
  player.campaignCode = null;

  if (campaign.masterId === player.id) {
    for (const otherPlayer of campaign.players.values()) {
      if (otherPlayer.ws) {
        send(otherPlayer.ws, {
          type: 'campaign_closed'
        });
      }
    }

    campaigns.delete(campaign.code);
    return;
  }

  broadcastCampaign(campaign);
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    game: 'A Caçada',
    server: 'online',
    campaigns: campaigns.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    server: 'online',
    campaigns: campaigns.size
  });
});

wss.on('connection', ws => {
  const player = {
    id: makeId('player'),
    name: 'Jogador',
    role: 'player',
    campaignCode: null,
    ws
  };

  sockets.set(ws, player);

  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, {
        type: 'error',
        error: 'INVALID_JSON'
      });
    }

    const id = message.id;

    try {
      switch (message.type) {

        case 'create_campaign': {
          removePlayerFromCampaign(player);

          const name = cleanText(
            message.name,
            'A Caçada — Nova Campanha'
          );

          const playerName = cleanText(
            message.playerName,
            'Mestre'
          );

          player.name = playerName;
          player.role = 'master';

          const code = makeCode();

          const campaign = {
            code,
            name,
            masterId: player.id,
            players: new Map(),
            characters: new Map()
          };

          campaign.players.set(player.id, player);

          player.campaignCode = code;

          campaigns.set(code, campaign);

          response(
            ws,
            id,
            true,
            campaignState(campaign, player)
          );

          break;
        }

        case 'join_campaign': {
          removePlayerFromCampaign(player);

          const code = String(message.code || '')
            .replace(/[^A-Z0-9-]/gi, '')
            .toUpperCase();

          const campaign = campaigns.get(code);

          if (!campaign) {
            return response(
              ws,
              id,
              false,
              null,
              'CAMPAIGN_NOT_FOUND'
            );
          }

          player.name = cleanText(
            message.playerName,
            'Jogador'
          );

          player.role = 'player';
          player.campaignCode = code;

          campaign.players.set(
            player.id,
            player
          );

          response(
            ws,
            id,
            true,
            campaignState(campaign, player)
          );

          broadcastCampaign(campaign);

          break;
        }

        case 'get_campaign': {
          const code = String(message.code || '')
            .replace(/[^A-Z0-9-]/gi, '')
            .toUpperCase();

          const campaign = campaigns.get(code);

          if (!campaign) {
            return response(
              ws,
              id,
              false,
              null,
              'CAMPAIGN_NOT_FOUND'
            );
          }

          if (player.campaignCode !== code) {
            player.campaignCode = code;

            player.role =
              campaign.masterId === player.id
                ? 'master'
                : 'player';

            campaign.players.set(
              player.id,
              player
            );
          }

          response(
            ws,
            id,
            true,
            campaignState(campaign, player)
          );

          break;
        }

        case 'save_character': {
          const campaign = findPlayerCampaign(player);

          if (!campaign) {
            return response(
              ws,
              id,
              false,
              null,
              'NOT_IN_CAMPAIGN'
            );
          }

          const characterId =
            String(message.characterId || '');

          let character = characterId
            ? campaign.characters.get(characterId)
            : null;

          if (
            character &&
            character.ownerId !== player.id &&
            player.role !== 'master'
          ) {
            return response(
              ws,
              id,
              false,
              null,
              'NOT_OWNER'
            );
          }

          if (!character) {
            character = {
              id: makeId('char'),
              ownerId: player.id,
              data: {}
            };

            campaign.characters.set(
              character.id,
              character
            );
          }

          character.data =
            message.character &&
            typeof message.character === 'object'
              ? message.character
              : {};

          response(
            ws,
            id,
            true,
            {
              character: publicCharacter(character)
            }
          );

          broadcastCampaign(campaign);

          break;
        }

        case 'delete_character': {
          const campaign = findPlayerCampaign(player);

          if (!campaign) {
            return response(
              ws,
              id,
              false,
              null,
              'NOT_IN_CAMPAIGN'
            );
          }

          const character =
            campaign.characters.get(
              String(message.characterId || '')
            );

          if (!character) {
            return response(
              ws,
              id,
              false,
              null,
              'CHARACTER_NOT_FOUND'
            );
          }

          if (
            character.ownerId !== player.id &&
            player.role !== 'master'
          ) {
            return response(
              ws,
              id,
              false,
              null,
              'NOT_OWNER'
            );
          }

          campaign.characters.delete(
            character.id
          );

          response(
            ws,
            id,
            true,
            {
              deletedId: character.id
            }
          );

          broadcastCampaign(campaign);

          break;
        }

        case 'leave_campaign': {
          removePlayerFromCampaign(player);

          response(
            ws,
            id,
            true,
            {
              ok: true
            }
          );

          break;
        }

        case 'ping': {
          response(
            ws,
            id,
            true,
            {
              pong: true
            }
          );

          break;
        }

        default: {
          response(
            ws,
            id,
            false,
            null,
            'UNKNOWN_ACTION'
          );
        }
      }

    } catch (error) {
      console.error(error);

      response(
        ws,
        id,
        false,
        null,
        'SERVER_ERROR'
      );
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);

    if (player.role === 'master') {
      removePlayerFromCampaign(player);
    } else {
      const campaign = findPlayerCampaign(player);

      if (campaign) {
        campaign.players.delete(player.id);
        player.campaignCode = null;
        broadcastCampaign(campaign);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(
    `A Caçada multiplayer listening on port ${PORT}`
  );
});
