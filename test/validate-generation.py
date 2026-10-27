import asyncio
import json
import pathlib
import sys
import uuid

root = pathlib.Path(__file__).resolve().parents[3] / 'App'
sys.path.insert(0, str(root / 'ComfyUI'))
sys.argv = [sys.argv[0], '--disable-auto-launch']
import folder_paths
from utils.extra_config import load_extra_path_config
folder_paths.set_input_directory(str(root / 'input'))
load_extra_path_config(str(root / 'extra_model_paths.yaml'))
import nodes
import execution
import server
from app.assets.manager import default_asset_manager


async def main():
    server.PromptServer(asyncio.get_running_loop(), default_asset_manager())
    await nodes.init_extra_nodes()
    cases = json.loads((root / 'logs/native-graphs-1.1.0.json').read_text(encoding='utf-8'))
    results = []
    for case in cases:
        valid = await execution.validate_prompt(str(uuid.uuid4()), case['graph'], None)
        result = {key: value for key, value in case.items() if key != 'graph'}
        result.update(ok=valid[0], errors=valid[3])
        results.append(result)
        print(json.dumps(result, ensure_ascii=False))
    (root / 'logs/native-validation-1.1.0.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    assert all(result['ok'] for result in results), 'Backend rejected one or more graphs'


asyncio.run(main())
