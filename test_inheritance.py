class Base:
    def method_a(self):
        print("Base method_a")

    def method_b(self):
        print("Base method_b")

class Child(Base):
    def method_a(self):
        # This overrides Base.method_a
        print("Child method_a")
        super().method_a()

    def method_c(self):
        print("Child method_c")

class GrandChild(Child):
    def method_a(self):
        # This overrides Child.method_a
        print("GrandChild method_a")

    def method_b(self):
        # This overrides Base.method_b
        print("GrandChild method_b")

    def method_c(self):
        # This overrides Child.method_c
        print("GrandChild method_c")
