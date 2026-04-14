class VariableTestBase:
    class_var_1 = 100
    class_var_2: str = "hello"


class VariableTestChild(VariableTestBase):
    class_var_1 = 200  # Overrides

    def method(self):
        instance_var = 10  # This should be ignored
