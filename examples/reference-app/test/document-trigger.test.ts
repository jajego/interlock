import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { permit, reset, testDatabase } from "./helpers.js";

const database = testDatabase();
test.after(async () => database.$disconnect());
test.beforeEach(async () => reset(database));

test("document trigger versions insert, update, move, and delete aggregates", async () => {
  const source = await permit(database, { permitNumber: 501 });
  const destination = await permit(database, { permitNumber: 502 });
  assert.equal(source.version, 1n);
  assert.equal(destination.version, 1n);

  const document = await database.permitDocument.create({
    data: {
      id: randomUUID(),
      permitId: source.id,
      kind: "plan",
      storageKey: `${source.id}/plan.pdf`,
    },
  });
  assert.equal(
    (await database.permit.findUniqueOrThrow({ where: { id: source.id } }))
      .version,
    2n,
  );

  await database.permitDocument.update({
    where: { id: document.id },
    data: { storageKey: `${source.id}/revised-plan.pdf` },
  });
  assert.equal(
    (await database.permit.findUniqueOrThrow({ where: { id: source.id } }))
      .version,
    3n,
  );

  await database.permitDocument.update({
    where: { id: document.id },
    data: { permitId: destination.id },
  });
  const [sourceAfterMove, destinationAfterMove, movedDocument] =
    await Promise.all([
      database.permit.findUniqueOrThrow({ where: { id: source.id } }),
      database.permit.findUniqueOrThrow({ where: { id: destination.id } }),
      database.permitDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ]);
  assert.equal(sourceAfterMove.version, 4n);
  assert.equal(destinationAfterMove.version, 2n);
  assert.equal(movedDocument.permitId, destination.id);

  await database.permitDocument.delete({ where: { id: document.id } });
  assert.equal(
    (
      await database.permit.findUniqueOrThrow({
        where: { id: destination.id },
      })
    ).version,
    3n,
  );
});
