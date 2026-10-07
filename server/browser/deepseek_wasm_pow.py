"""
DeepSeek PoW solver using DeepSeek's official WASM module.

Runs the same sha3_wasm_bg.wasm the browser runs (via wasmtime), so the
nonce validates server-side. Pure-Python keccak/sha3 fallbacks implement a
different hash than DeepSeekHashV1 and never validate, which is why the old
brute-force loop always failed.
"""

import logging
from pathlib import Path
from typing import Any, Dict, Optional

LOGGER = logging.getLogger("webchat2local.deepseek")

WASM_PATH = Path(__file__).resolve().parent / "deepseek_wasm" / "sha3_wasm_bg.wasm"

_solver = None


class WasmPowSolver:
    """Call DeepSeek's wasm_solve(challenge, prefix, difficulty) -> nonce."""

    def __init__(self, wasm_path: Path):
        import wasmtime
        import numpy as np

        self._np = np
        engine = wasmtime.Engine()
        module = wasmtime.Module(engine, wasm_path.read_bytes())
        self.store = wasmtime.Store(engine)
        linker = wasmtime.Linker(engine)
        try:
            linker.define_wasi()
        except Exception:
            pass
        self.instance = linker.instantiate(self.store, module)
        self.memory = self.instance.exports(self.store)["memory"]

    def _write(self, text: str):
        data = text.encode("utf-8")
        alloc = self.instance.exports(self.store)["__wbindgen_export_0"]
        ptr = alloc(self.store, len(data), 1)
        view = self.memory.data_ptr(self.store)
        for i, b in enumerate(data):
            view[ptr + i] = b
        return ptr, len(data)

    def solve(self, challenge: Dict[str, Any]) -> int:
        prefix = f"{challenge['salt']}_{challenge['expire_at']}_"
        exports = self.instance.exports(self.store)
        retptr = exports["__wbindgen_add_to_stack_pointer"](self.store, -16)
        try:
            c_ptr, c_len = self._write(str(challenge["challenge"]))
            p_ptr, p_len = self._write(prefix)
            exports["wasm_solve"](
                self.store, retptr, c_ptr, c_len, p_ptr, p_len,
                float(challenge["difficulty"]),
            )
            view = self.memory.data_ptr(self.store)
            status = int.from_bytes(bytes(view[retptr:retptr + 4]), "little", signed=True)
            if status == 0:
                raise RuntimeError("wasm returned no solution")
            raw = bytes(view[retptr + 8:retptr + 16])
            return int(self._np.frombuffer(raw, dtype=self._np.float64)[0])
        finally:
            exports["__wbindgen_add_to_stack_pointer"](self.store, 16)


def get_solver() -> Optional[WasmPowSolver]:
    """Lazy singleton; None when wasm/wasmtime unavailable."""
    global _solver
    if _solver is not None:
        return _solver
    if not WASM_PATH.exists():
        LOGGER.warning("⚠️ [DEEPSEEK PoW] WASM 缺失: %s", WASM_PATH)
        return None
    try:
        _solver = WasmPowSolver(WASM_PATH)
        LOGGER.info("✅ [DEEPSEEK PoW] WASM solver 就緒")
        return _solver
    except Exception as e:
        LOGGER.warning("⚠️ [DEEPSEEK PoW] WASM 初始化失敗: %s", e)
        return None
