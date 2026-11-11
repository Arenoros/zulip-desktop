import test from "tape";

import {
  chosenSource,
  sourceKind,
  sourcesToOffer,
} from "../app/main/share-source.ts";

const primaryScreen = {id: "screen:0:0", name: "Screen 1"};
const otherScreen = {id: "screen:1:0", name: "Screen 2"};
const editor = {id: "window:101:0", name: "Editor"};
const callWindow = {id: "window:102:0", name: "Zulip"};
const untitled = {id: "window:103:0", name: " "};

test("Sources are screens or windows", (t) => {
  t.equal(sourceKind(primaryScreen.id), "screen");
  t.equal(sourceKind(editor.id), "window");
  t.end();
});

test("Screens come first, without excluded and untitled windows", (t) => {
  t.deepEqual(
    sourcesToOffer(
      [editor, primaryScreen, untitled, callWindow, otherScreen],
      new Set([callWindow.id]),
    ),
    [primaryScreen, otherScreen, editor],
  );
  t.end();
});

test("Only an offered source can be chosen", (t) => {
  const offered = [primaryScreen, editor];
  t.equal(chosenSource(editor.id, offered), editor);
  t.equal(chosenSource(primaryScreen.id, offered), primaryScreen);
  t.equal(chosenSource(callWindow.id, offered), undefined, "not offered");
  t.equal(chosenSource({id: editor.id}, offered), undefined, "not an ID");
  t.equal(chosenSource(undefined, offered), undefined);
  t.end();
});
