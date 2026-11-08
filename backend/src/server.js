const app = require("./app");
const { db } = require("./database");
const { closeWorkers } = require("./extractor");

const port = Number(process.env.PORT || 8000);

app.locals.initPromise
  .then(() => {
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`Document Processor Node.js API listening on port ${port}`);
    });

    const shutdown = () => {
      server.close(() => {
        closeWorkers()
          .catch((error) => console.error("Unable to stop OCR worker cleanly.", error))
          .finally(() => {
            db.close();
            process.exit(0);
          });
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((error) => {
    console.error("Unable to initialize the document processor API.", error);
    process.exitCode = 1;
  });
