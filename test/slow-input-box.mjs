// A mock input box that commits typed characters to its model ASYNCHRONOUSLY
// (as Ink/React-based TUIs do), reproducing the ordering race: if a submit
// key is processed before the paste has been committed, it submits partial
// text. session_write must hold trailing keys until the input has settled.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("latin1");

let committed = "";
process.stdout.write("BOX-READY\r\n");

process.stdin.on("data", (chunk) => {
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") {
      // Submit reads the CURRENT committed model — not chars still in flight.
      process.stdout.write(`SUBMIT:[${committed}]\r\n`);
      committed = "";
    } else {
      process.stdout.write(ch); // echo immediately (updates the screen / lastDataAt)
      // ...but the model commit is deferred, as an async re-render would be.
      setTimeout(() => {
        committed += ch;
      }, 25);
    }
  }
});

setTimeout(() => process.exit(0), 30_000).unref();
