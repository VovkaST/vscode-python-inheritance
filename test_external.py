import json
from abc import ABC, abstractmethod


class MyEncoder(json.JSONEncoder):
    def default(self, obj):
        # This overrides json.JSONEncoder.default
        return super().default(obj)


class MyBase(ABC):
    @abstractmethod
    def run(self):
        pass


class MyImpl(MyBase):
    def run(self):
        # This overrides MyBase.run
        print("Running...")
