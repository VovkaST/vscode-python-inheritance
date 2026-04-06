from base import Parent

class Child(Parent):
    def greet(self):
        # This overrides Parent.greet in another file
        print("Hello from Child")
        super().greet()

    def method_only_in_child(self):
        print("Child only")

class GrandChild(Child):
    def greet(self):
        # This overrides Child.greet
        print("Hello from GrandChild")
