// UCI operations as data. A page's model turns the edited form into a list of operations, each
//   { op: 'set' | 'add' | 'delete', config, section, type?, name?, values? | options? }
// so what will be written can be reviewed and unit-tested without a router; stageOps() then stages them through a
// uci API (core/uci.js createUci). Pure: no session and no network of its own.

// Stages the operations in order through `ed`, a uci API.
export async function stageOps(ed, ops) {
  for (const o of ops) {
    if (o.op === 'set') await ed.set(o.config, o.section, o.values);
    else if (o.op === 'add') await ed.add(o.config, o.type, o.values, o.name);
    else await ed.delete(o.config, o.section, o.options);
  }
}
