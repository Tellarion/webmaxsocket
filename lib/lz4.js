/**
 * Распаковка LZ4-блока (как в протоколе Max).
 * Сначала нативный `lz4` (нужен node-gyp / VS C++ на Windows), иначе чистый JS `lz4js`.
 */
function resolveLz4Uncompress() {
  try {
    const lz4Binding = require('lz4/lib/binding.js');
    return (inp, out) => lz4Binding.uncompress(inp, out);
  } catch (_) {
    try {
      const lz4js = require('lz4js');
      return (inp, out) => lz4js.decompressBlock(inp, out, 0, inp.length, 0);
    } catch (e) {
      throw new Error(
        'LZ4: установите зависимость `lz4js` (npm i lz4js) или соберите нативный `lz4` (Visual Studio, C++ workload). ' +
          e.message
      );
    }
  }
}

const lz4Uncompress = resolveLz4Uncompress();

module.exports = { lz4Uncompress };
