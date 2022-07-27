import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProductsWithJsonComponent } from './products-with-json.component';

describe('ProductsWithJsonComponent', () => {
  let component: ProductsWithJsonComponent;
  let fixture: ComponentFixture<ProductsWithJsonComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ ProductsWithJsonComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ProductsWithJsonComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
