import ast
import sys

try:
    with open('controller/chat_controller.py', 'r', encoding='utf-8') as f:
        source = f.read()
    ast.parse(source)
    print('SYNTAX OK')
except SyntaxError as e:
    print(f'SYNTAX ERROR at line {e.lineno}, col {e.offset}:')
    print(f'  {e.msg}')
    print(f'  {e.text}')
