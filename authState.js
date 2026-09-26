import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

async function cmd(url, token, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function useUpstashAuthState(url, token) {
  const prefix = 'wabot:';
  const write = (data, id) =>
    cmd(url, token, ['SET', prefix + id, JSON.stringify(data, BufferJSON.replacer)]);
  const read = async (id) => {
    const v = await cmd(url, token, ['GET', prefix + id]);
    return v ? JSON.parse(v, BufferJSON.reviver) : null;
  };
  const remove = (id) => cmd(url, token, ['DEL', prefix + id]);

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(value, key) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds'),
  };
}
