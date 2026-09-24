import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

export async function useMongoAuthState(col) {
  const write = (data, id) =>
    col.replaceOne({ _id: id }, { _id: id, v: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
  const read = async (id) => {
    const d = await col.findOne({ _id: id });
    return d ? JSON.parse(d.v, BufferJSON.reviver) : null;
  };
  const remove = (id) => col.deleteOne({ _id: id });

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
