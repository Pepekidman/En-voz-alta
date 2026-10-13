"""Genera un modelo ONNX de prueba con la misma interfaz que una voz Piper.

Entradas: input [1, N] int64 (ids de fonemas), input_lengths [1] int64,
scales [3] float32. Salida: output [1, 1, T] float32 (audio). Produce un tono
cuya duración es proporcional al número de fonemas: sirve para probar toda la
cadena (fonemas → inferencia → audio → reproducción) sin descargar una voz real.
Uso: python3 tests/make_test_voice.py
"""
import json
import os

import onnx
from onnx import TensorProto, helper

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures', 'neural')
os.makedirs(OUT, exist_ok=True)

SAMPLES_PER_ID = 512

def const(name, dtype, dims, vals):
    return helper.make_node('Constant', [], [name], value=helper.make_tensor(name + '_v', dtype, dims, vals))

nodes = [
    helper.make_node('Cast', ['input'], ['xf'], to=TensorProto.FLOAT),
    const('ax2', TensorProto.INT64, [1], [2]),
    helper.make_node('Unsqueeze', ['xf', 'ax2'], ['x3']),
    const('rep', TensorProto.INT64, [3], [1, 1, SAMPLES_PER_ID]),
    helper.make_node('Tile', ['x3', 'rep'], ['tiled']),
    const('shape', TensorProto.INT64, [3], [1, 1, -1]),
    helper.make_node('Reshape', ['tiled', 'shape'], ['flat']),
    const('freq', TensorProto.FLOAT, [], [0.37]),
    helper.make_node('Mul', ['flat', 'freq'], ['phase']),
    helper.make_node('Sin', ['phase'], ['wave']),
    const('idx1', TensorProto.INT64, [], [1]),
    helper.make_node('Gather', ['scales', 'idx1'], ['length_scale'], axis=0),
    const('amp', TensorProto.FLOAT, [], [0.25]),
    helper.make_node('Mul', ['length_scale', 'amp'], ['gain']),
    helper.make_node('Mul', ['wave', 'gain'], ['scaled']),
    helper.make_node('Cast', ['input_lengths'], ['lenf'], to=TensorProto.FLOAT),
    const('zero', TensorProto.FLOAT, [], [0.0]),
    helper.make_node('Mul', ['lenf', 'zero'], ['lenzero']),
    helper.make_node('Add', ['scaled', 'lenzero'], ['output']),
]
graph = helper.make_graph(
    nodes, 'test_voice',
    [
        helper.make_tensor_value_info('input', TensorProto.INT64, [1, 'N']),
        helper.make_tensor_value_info('input_lengths', TensorProto.INT64, [1]),
        helper.make_tensor_value_info('scales', TensorProto.FLOAT, [3]),
    ],
    [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1, 'T'])],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)], producer_name='en-voz-alta-test')
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, os.path.join(OUT, 'test-voice.onnx'))

config = {
    'audio': {'sample_rate': 22050, 'quality': 'test'},
    'espeak': {'voice': 'es'},
    'inference': {'noise_scale': 0.667, 'length_scale': 1, 'noise_w': 0.8},
    'phoneme_type': 'espeak',
    'num_speakers': 1,
    'speaker_id_map': {},
    'language': {'code': 'es_ES'},
    'dataset': 'test'
}
json.dump(config, open(os.path.join(OUT, 'test-voice.onnx.json'), 'w'), indent=2)
print('ok', os.path.getsize(os.path.join(OUT, 'test-voice.onnx')), 'bytes')
