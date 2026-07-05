const stateFile = process.argv[2]
const exit = Number(process.argv[3])
const count = (await Bun.file(stateFile).exists()) ? Number(await Bun.file(stateFile).text()) : 0

await Bun.write(stateFile, String(count + 1))
process.exit(exit || (count === 0 ? 75 : 0))
